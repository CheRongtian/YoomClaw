import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let helperVersion = "0.1.0"
private let maxChildren = 100
private let maxDepth = 4

struct ControlFailure: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) -> ControlFailure {
    ControlFailure(code: code, message: message)
}

func attribute(_ element: AXUIElement, _ name: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
    attribute(element, name) as? String ?? ""
}

func boolAttribute(_ element: AXUIElement, _ name: CFString, fallback: Bool = false) -> Bool {
    attribute(element, name) as? Bool ?? fallback
}

func pointValue(_ value: AnyObject?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func sizeValue(_ value: AnyObject?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func bounds(_ element: AXUIElement) -> [String: Int]? {
    guard let origin = pointValue(attribute(element, kAXPositionAttribute as CFString)),
          let size = sizeValue(attribute(element, kAXSizeAttribute as CFString)) else { return nil }
    return [
        "x": Int(origin.x.rounded()), "y": Int(origin.y.rounded()),
        "width": Int(size.width.rounded()), "height": Int(size.height.rounded()),
    ]
}

func roleName(_ role: String) -> String {
    switch role {
    case kAXButtonRole: return "Button"
    case kAXTextFieldRole, kAXTextAreaRole: return "Edit"
    case kAXStaticTextRole: return "Text"
    case kAXWindowRole: return "Window"
    case kAXGroupRole, kAXScrollAreaRole: return "Pane"
    case kAXListRole: return "List"
    case kAXRowRole: return "ListItem"
    case kAXPopUpButtonRole, kAXComboBoxRole: return "ComboBox"
    case kAXCheckBoxRole: return "CheckBox"
    case kAXRadioButtonRole: return "RadioButton"
    case kAXTabGroupRole: return "Tab"
    case kAXMenuItemRole: return "MenuItem"
    case kAXOutlineRole: return "Tree"
    case kAXSliderRole: return "Slider"
    default: return role.replacingOccurrences(of: "AX", with: "")
    }
}

func isSecure(_ element: AXUIElement) -> Bool {
    let subrole = stringAttribute(element, kAXSubroleAttribute as CFString)
    return subrole.localizedCaseInsensitiveContains("secure") || subrole.localizedCaseInsensitiveContains("password")
}

func elementInfo(_ element: AXUIElement, includeValue: Bool = false, depth: Int? = nil) -> [String: Any] {
    var result: [String: Any] = [
        "name": stringAttribute(element, kAXTitleAttribute as CFString).isEmpty
            ? stringAttribute(element, kAXDescriptionAttribute as CFString)
            : stringAttribute(element, kAXTitleAttribute as CFString),
        "automationId": stringAttribute(element, "AXIdentifier" as CFString),
        "controlType": roleName(stringAttribute(element, kAXRoleAttribute as CFString)),
        "enabled": boolAttribute(element, kAXEnabledAttribute as CFString, fallback: true),
    ]
    if let frame = bounds(element) { result["bounds"] = frame }
    if includeValue && !isSecure(element), let value = attribute(element, kAXValueAttribute as CFString) {
        let text = String(describing: value)
        result["value"] = String(text.prefix(2000))
    }
    if let depth {
        if depth >= maxDepth {
            result["children"] = []
        } else {
            let children = (attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
            result["children"] = children.prefix(maxChildren).map { elementInfo($0, depth: depth + 1) }
        }
    }
    return result
}

func trusted() -> Bool {
    AXIsProcessTrusted()
}

func requireTrusted() throws {
    guard trusted() else {
        throw fail("ACCESSIBILITY_PERMISSION_REQUIRED", "Allow YoomClaw in System Settings > Privacy & Security > Accessibility, then restart the app.")
    }
}

func windowRecords() -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    return CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
}

func windowInfo(_ record: [String: Any]) -> [String: Any]? {
    guard let id = record[kCGWindowNumber as String] as? NSNumber,
          let pid = record[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
    let layer = (record[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
    let title = (record[kCGWindowName as String] as? String) ?? ""
    let owner = (record[kCGWindowOwnerName as String] as? String) ?? ""
    guard layer == 0, !owner.isEmpty else { return nil }
    var result: [String: Any] = [
        "hwnd": id.intValue,
        "title": title.isEmpty ? owner : title,
        "processId": pid.intValue,
        "processName": owner,
        "visible": true,
    ]
    if let raw = record[kCGWindowBounds as String] as? NSDictionary,
       let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) {
        result["bounds"] = ["x": Int(rect.origin.x), "y": Int(rect.origin.y), "width": Int(rect.width), "height": Int(rect.height)]
    }
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    result["focused"] = frontmostPid == pid.int32Value
    return result
}

func listWindows() throws -> [[String: Any]] {
    try requireTrusted()
    return windowRecords().compactMap(windowInfo)
}

func windowRecord(_ id: Int) throws -> [String: Any] {
    guard let record = windowRecords().first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == id }) else {
        throw fail("WINDOW_NOT_FOUND", "The target window no longer exists.")
    }
    return record
}

func axWindow(_ id: Int) throws -> (AXUIElement, pid_t, [String: Any]) {
    try requireTrusted()
    let record = try windowRecord(id)
    guard let pidNumber = record[kCGWindowOwnerPID as String] as? NSNumber else {
        throw fail("WINDOW_NOT_FOUND", "The target window has no owning process.")
    }
    let pid = pid_t(pidNumber.int32Value)
    let app = AXUIElementCreateApplication(pid)
    let windows = (attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement]) ?? []
    guard !windows.isEmpty else { throw fail("AX_WINDOW_NOT_FOUND", "The target window is not visible to macOS Accessibility.") }
    let expectedTitle = record[kCGWindowName as String] as? String ?? ""
    let expectedBounds = record[kCGWindowBounds as String] as? NSDictionary
    let expectedRect = expectedBounds.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
    let match = windows.first { element in
        let title = stringAttribute(element, kAXTitleAttribute as CFString)
        if !expectedTitle.isEmpty && title == expectedTitle { return true }
        guard let expectedRect, let actual = bounds(element) else { return false }
        return abs((actual["x"] ?? 0) - Int(expectedRect.origin.x)) <= 3
            && abs((actual["y"] ?? 0) - Int(expectedRect.origin.y)) <= 3
            && abs((actual["width"] ?? 0) - Int(expectedRect.width)) <= 6
            && abs((actual["height"] ?? 0) - Int(expectedRect.height)) <= 6
    } ?? windows[0]
    return (match, pid, record)
}

func selectorMatches(_ element: AXUIElement, _ selector: [String: Any]) -> Bool {
    if let name = selector["name"] as? String, !name.isEmpty {
        let actual = stringAttribute(element, kAXTitleAttribute as CFString).isEmpty
            ? stringAttribute(element, kAXDescriptionAttribute as CFString)
            : stringAttribute(element, kAXTitleAttribute as CFString)
        if actual.compare(name, options: .caseInsensitive) != .orderedSame { return false }
    }
    if let identifier = selector["automationId"] as? String, !identifier.isEmpty,
       stringAttribute(element, "AXIdentifier" as CFString) != identifier { return false }
    if let type = selector["controlType"] as? String, !type.isEmpty,
       roleName(stringAttribute(element, kAXRoleAttribute as CFString)).compare(type, options: .caseInsensitive) != .orderedSame { return false }
    return true
}

func descendants(_ root: AXUIElement, limit: Int = 2500) -> [AXUIElement] {
    var result: [AXUIElement] = []
    var queue: [AXUIElement] = (attribute(root, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
    while !queue.isEmpty && result.count < limit {
        let next = queue.removeFirst()
        result.append(next)
        if let children = attribute(next, kAXChildrenAttribute as CFString) as? [AXUIElement] {
            queue.append(contentsOf: children.prefix(maxChildren))
        }
    }
    return result
}

func findElement(_ window: AXUIElement, _ selector: [String: Any]?) throws -> AXUIElement {
    guard let selector else { throw fail("ELEMENT_REQUIRED", "An Accessibility element selector is required.") }
    let hasSelector = ["name", "automationId", "controlType"].contains { (selector[$0] as? String)?.isEmpty == false }
    guard hasSelector else { throw fail("ELEMENT_SELECTOR_REQUIRED", "Element selector needs name, automationId, or controlType.") }
    let matches = descendants(window).filter { selectorMatches($0, selector) }
    guard !matches.isEmpty else { throw fail("ELEMENT_NOT_FOUND", "No matching Accessibility element was found.") }
    if selector["index"] == nil && matches.count != 1 {
        throw fail("ELEMENT_AMBIGUOUS", "The Accessibility selector matched \(matches.count) elements.")
    }
    let index = (selector["index"] as? NSNumber)?.intValue ?? 0
    guard index >= 0 && index < matches.count else { throw fail("ELEMENT_INDEX_INVALID", "The Accessibility selector index is out of range.") }
    return matches[index]
}

func focusWindow(_ id: Int) throws -> [String: Any] {
    let (window, pid, record) = try axWindow(id)
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    Thread.sleep(forTimeInterval: 0.08)
    return windowInfo(record) ?? ["hwnd": id, "title": ""]
}

func clickElement(_ id: Int, _ selector: [String: Any]?) throws -> [String: Any] {
    let (window, _, _) = try axWindow(id)
    let element = try findElement(window, selector)
    if isSecure(element) { throw fail("SENSITIVE_CONTROL_BLOCKED", "Password and secure input controls cannot be operated.") }
    try _ = focusWindow(id)
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
        guard let frame = bounds(element) else { throw fail("ELEMENT_NOT_ACTIONABLE", "The element cannot be pressed and has no usable bounds.") }
        let point = CGPoint(x: CGFloat((frame["x"] ?? 0) + (frame["width"] ?? 0) / 2), y: CGFloat((frame["y"] ?? 0) + (frame["height"] ?? 0) / 2))
        guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw fail("INPUT_INJECTION_FAILED", "Unable to create a mouse event.")
        }
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    }
    return elementInfo(element)
}

func typeText(_ id: Int, _ selector: [String: Any]?, _ text: String?) throws -> [String: Any] {
    guard let text else { throw fail("TEXT_REQUIRED", "Text is required.") }
    let (window, _, _) = try axWindow(id)
    let element = try findElement(window, selector)
    if isSecure(element) { throw fail("SENSITIVE_CONTROL_BLOCKED", "Password and secure input controls cannot be operated.") }
    try _ = focusWindow(id)
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
    guard result == .success else { throw fail("ELEMENT_NOT_EDITABLE", "The selected element does not accept Accessibility text input.") }
    return elementInfo(element)
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]

func pressKey(_ id: Int, _ key: String?) throws -> [String: Any] {
    guard let key, let code = keyCodes[key.lowercased()] else { throw fail("KEY_UNSUPPORTED", "Supported keys: enter, tab, space, delete, escape, arrows, home, end, pageup, pagedown.") }
    try _ = focusWindow(id)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw fail("INPUT_INJECTION_FAILED", "Unable to create a keyboard event.") }
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    return ["hwnd": id, "key": key]
}

func scroll(_ id: Int, _ direction: String?, _ selector: [String: Any]?) throws -> [String: Any] {
    guard direction == "up" || direction == "down" else { throw fail("DIRECTION_REQUIRED", "Scroll direction must be up or down.") }
    let (window, _, record) = try axWindow(id)
    let element = try selector.map { try findElement(window, $0) }
    try _ = focusWindow(id)
    if let frame = element.flatMap(bounds) {
        let point = CGPoint(x: CGFloat((frame["x"] ?? 0) + (frame["width"] ?? 0) / 2), y: CGFloat((frame["y"] ?? 0) + (frame["height"] ?? 0) / 2))
        CGWarpMouseCursorPosition(point)
    }
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: direction == "up" ? 5 : -5, wheel2: 0, wheel3: 0) else {
        throw fail("INPUT_INJECTION_FAILED", "Unable to create a scroll event.")
    }
    event.post(tap: .cghidEventTap)
    return element.map { elementInfo($0) } ?? windowInfo(record) ?? ["hwnd": id, "title": ""]
}

func readElement(_ id: Int, _ selector: [String: Any]?) throws -> [String: Any] {
    let (window, _, _) = try axWindow(id)
    let element = try findElement(window, selector)
    if isSecure(element) { throw fail("SENSITIVE_CONTROL_BLOCKED", "Password and secure input controls cannot be read.") }
    let value = attribute(element, kAXValueAttribute as CFString).map { String(describing: $0) }
        ?? stringAttribute(element, kAXTitleAttribute as CFString)
    return ["value": String(value.prefix(2000)), "element": elementInfo(element)]
}

func screenshot(_ id: Int, _ outputPath: String?) throws -> [String: Any] {
    guard let outputPath, !outputPath.isEmpty else { throw fail("OUTPUT_PATH_REQUIRED", "A screenshot output path is required.") }
    _ = try windowRecord(id)
    guard CGPreflightScreenCaptureAccess() else {
        CGRequestScreenCaptureAccess()
        throw fail("SCREEN_RECORDING_PERMISSION_REQUIRED", "Allow YoomClaw in System Settings > Privacy & Security > Screen Recording, then restart the app.")
    }
    let url = URL(fileURLWithPath: outputPath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l", String(id), outputPath]
    let errorPipe = Pipe()
    process.standardError = errorPipe
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0, FileManager.default.fileExists(atPath: outputPath) else {
        let data = errorPipe.fileHandleForReading.readDataToEndOfFile()
        let message = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        throw fail("SCREENSHOT_FAILED", message?.isEmpty == false ? message! : "macOS could not capture the selected window.")
    }
    return ["hwnd": id, "path": outputPath]
}

func appendAudit(_ request: [String: Any], success: Bool, errorCode: String?) {
    guard let auditPath = request["auditPath"] as? String, !auditPath.isEmpty else { return }
    var record: [String: Any] = [
        "timestamp": ISO8601DateFormatter().string(from: Date()),
        "action": request["action"] as? String ?? "",
        "success": success,
    ]
    if let hwnd = request["hwnd"] { record["hwnd"] = hwnd }
    if let selector = request["element"] as? [String: Any] {
        record["element"] = selector.filter { ["name", "automationId", "controlType", "index"].contains($0.key) }
    }
    if let errorCode { record["errorCode"] = errorCode }
    do {
        let url = URL(fileURLWithPath: auditPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: record)
        if !FileManager.default.fileExists(atPath: auditPath) { FileManager.default.createFile(atPath: auditPath, contents: nil) }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: data + Data([0x0a]))
        try handle.close()
    } catch { }
}

func dispatch(_ request: [String: Any]) throws -> Any {
    guard let action = request["action"] as? String, !action.isEmpty else { throw fail("ACTION_REQUIRED", "Action is required.") }
    let id = (request["hwnd"] as? NSNumber)?.intValue
    switch action {
    case "ping": return ["version": helperVersion, "platform": "darwin", "accessibilityTrusted": trusted()]
    case "list_windows": return try listWindows()
    case "inspect":
        guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }
        let (window, _, _) = try axWindow(id)
        let root = try (request["element"] as? [String: Any]).map { try findElement(window, $0) } ?? window
        return elementInfo(root, depth: 0)
    case "screenshot": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try screenshot(id, request["outputPath"] as? String)
    case "focus": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try focusWindow(id)
    case "click": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try clickElement(id, request["element"] as? [String: Any])
    case "type": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try typeText(id, request["element"] as? [String: Any], request["text"] as? String)
    case "press_key": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try pressKey(id, request["key"] as? String)
    case "scroll": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try scroll(id, request["direction"] as? String, request["element"] as? [String: Any])
    case "read": guard let id else { throw fail("WINDOW_REQUIRED", "A target window handle is required.") }; return try readElement(id, request["element"] as? [String: Any])
    default: throw fail("ACTION_UNSUPPORTED", "Unsupported action: \(action)")
    }
}

while let line = readLine() {
    guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
    var request: [String: Any] = [:]
    var response: [String: Any]
    do {
        guard let data = line.data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("REQUEST_INVALID", "Request must be a JSON object.") }
        request = object
        let result = try dispatch(request)
        appendAudit(request, success: true, errorCode: nil)
        response = ["id": request["id"] ?? NSNull(), "ok": true, "result": result]
    } catch let error as ControlFailure {
        appendAudit(request, success: false, errorCode: error.code)
        response = ["id": request["id"] ?? NSNull(), "ok": false, "error": ["code": error.code, "message": error.message]]
    } catch {
        appendAudit(request, success: false, errorCode: "COMPUTER_INTERNAL_ERROR")
        response = ["id": request["id"] ?? NSNull(), "ok": false, "error": ["code": "COMPUTER_INTERNAL_ERROR", "message": error.localizedDescription]]
    }
    if let data = try? JSONSerialization.data(withJSONObject: response), let output = String(data: data, encoding: .utf8) {
        print(output)
        fflush(stdout)
    }
}
