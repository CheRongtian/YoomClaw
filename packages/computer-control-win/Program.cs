using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;

namespace YoomClaw.ComputerControl;

internal static class Program
{
    private const string Version = "0.1.0";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = false,
    };

    public static void Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            Response response;
            Request? request = null;
            try
            {
                request = JsonSerializer.Deserialize<Request>(line, JsonOptions)
                    ?? throw new ControlException("REQUEST_INVALID", "Request must be a JSON object.");
                response = Dispatch(request);
            }
            catch (ControlException error)
            {
                response = Response.Error(request?.Id, error.Code, error.Message);
            }
            catch (Exception error)
            {
                response = Response.Error(request?.Id, "COMPUTER_INTERNAL_ERROR", error.Message);
            }

            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            Console.Out.Flush();
        }
    }

    private static Response Dispatch(Request request)
    {
        if (string.IsNullOrWhiteSpace(request.Action))
            throw new ControlException("ACTION_REQUIRED", "Action is required.");

        try
        {
            object result = request.Action switch
            {
                "ping" => new { version = Version },
                "list_windows" => ListWindows(),
                "inspect" => Inspect(RequireWindow(request), request.Element),
                "screenshot" => Screenshot(RequireWindow(request), request.OutputPath),
                "focus" => WindowInfo.FromElement(Focus(RequireWindow(request))),
                "click" => Click(RequireWindow(request), request.Element, request.AllowInputInjection),
                "type" => TypeText(RequireWindow(request), request.Element, request.Text, request.AllowInputInjection),
                "press_key" => PressKey(RequireWindow(request), request.Key, request.AllowInputInjection),
                "scroll" => Scroll(RequireWindow(request), request.Direction, request.Element, request.AllowInputInjection),
                "read" => ReadValue(RequireWindow(request), request.Element),
                _ => throw new ControlException("ACTION_UNSUPPORTED", $"Unsupported action: {request.Action}"),
            };
            WriteAudit(request, success: true, errorCode: null);
            return Response.Success(request.Id, result);
        }
        catch (ControlException error)
        {
            WriteAudit(request, false, error.Code);
            throw;
        }
        catch
        {
            WriteAudit(request, success: false, "COMPUTER_INTERNAL_ERROR");
            throw;
        }
    }

    private static void WriteAudit(Request request, bool success, string? errorCode)
    {
        if (string.IsNullOrWhiteSpace(request.AuditPath)) return;
        try
        {
            string? windowTitle = null;
            if (request.Hwnd is > 0 && IsWindow(new IntPtr(request.Hwnd.Value)))
            {
                try { windowTitle = AutomationElement.FromHandle(new IntPtr(request.Hwnd.Value))?.Current.Name; }
                catch { }
            }

            var record = new
            {
                timestamp = DateTimeOffset.UtcNow,
                action = request.Action,
                hwnd = request.Hwnd,
                windowTitle,
                element = request.Element is null ? null : new
                {
                    name = request.Element.Name,
                    automationId = request.Element.AutomationId,
                    controlType = request.Element.ControlType,
                    index = request.Element.Index,
                },
                success,
                errorCode,
            };
            var fullPath = Path.GetFullPath(request.AuditPath);
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            File.AppendAllText(fullPath, JsonSerializer.Serialize(record, JsonOptions) + Environment.NewLine, System.Text.Encoding.UTF8);
        }
        catch
        {
            // Audit failure must not turn an otherwise valid UI action into a failure.
        }
    }

    private static AutomationElement RequireWindow(Request request)
    {
        if (request.Hwnd is null || request.Hwnd <= 0)
            throw new ControlException("WINDOW_REQUIRED", "A target window handle is required.");

        var handle = new IntPtr(request.Hwnd.Value);
        if (!IsWindow(handle))
            throw new ControlException("WINDOW_NOT_FOUND", "The target window no longer exists.");

        try
        {
            return AutomationElement.FromHandle(handle)
                ?? throw new ControlException("UIA_WINDOW_NOT_FOUND", "The target window is not visible to UI Automation.");
        }
        catch (ControlException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new ControlException("UIA_WINDOW_NOT_FOUND", error.Message);
        }
    }

    private static WindowInfo[] ListWindows()
    {
        var root = AutomationElement.RootElement;
        var condition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window);
        var elements = root.FindAll(TreeScope.Children, condition);
        var result = new List<WindowInfo>();
        for (var index = 0; index < elements.Count; index++)
        {
            try
            {
                var element = elements[index];
                var info = WindowInfo.FromElement(element);
                if (info.Hwnd > 0 && !string.IsNullOrWhiteSpace(info.Title)) result.Add(info);
            }
            catch
            {
                // Windows can disappear while the desktop tree is enumerated.
            }
        }
        return result.ToArray();
    }

    private static ElementInfo Inspect(AutomationElement window, Selector? selector)
    {
        var root = selector is null ? window : FindSingle(window, selector);
        return BuildElement(root, 0, includeValue: false);
    }

    private static ElementInfo BuildElement(AutomationElement element, int depth, bool includeValue)
    {
        var info = ElementInfo.FromElement(element, includeValue);
        if (depth >= 4) return info;

        try
        {
            var children = element.FindAll(TreeScope.Children, Condition.TrueCondition);
            var result = new List<ElementInfo>();
            for (var index = 0; index < Math.Min(children.Count, 100); index++)
            {
                try { result.Add(BuildElement(children[index], depth + 1, includeValue: false)); }
                catch { }
            }
            info.Children = result.ToArray();
        }
        catch
        {
            info.Children = Array.Empty<ElementInfo>();
        }
        return info;
    }

    private static AutomationElement FindSingle(AutomationElement window, Selector selector)
    {
        var conditions = new List<Condition>();
        if (!string.IsNullOrWhiteSpace(selector.Name))
            conditions.Add(new PropertyCondition(AutomationElement.NameProperty, selector.Name, PropertyConditionFlags.IgnoreCase));
        if (!string.IsNullOrWhiteSpace(selector.AutomationId))
            conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, selector.AutomationId));
        if (!string.IsNullOrWhiteSpace(selector.ControlType))
            conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ParseControlType(selector.ControlType)));
        if (conditions.Count == 0)
            throw new ControlException("ELEMENT_SELECTOR_REQUIRED", "At least one UI Automation selector field is required.");

        var condition = conditions.Count == 1 ? conditions[0] : new AndCondition(conditions.ToArray());
        var matches = window.FindAll(TreeScope.Descendants, condition);
        if (matches.Count == 0) throw new ControlException("ELEMENT_NOT_FOUND", "No matching UI Automation element was found.");
        if (selector.Index is null && matches.Count != 1)
            throw new ControlException("ELEMENT_AMBIGUOUS", $"The UI Automation selector matched {matches.Count} elements.");
        var index = selector.Index ?? 0;
        if (index < 0 || index >= matches.Count)
            throw new ControlException("ELEMENT_INDEX_INVALID", "The UI Automation selector index is out of range.");
        return matches[index];
    }

    private static ControlType ParseControlType(string value)
    {
        return value.Trim().ToLowerInvariant() switch
        {
            "button" => ControlType.Button,
            "edit" or "textbox" => ControlType.Edit,
            "text" => ControlType.Text,
            "window" => ControlType.Window,
            "pane" => ControlType.Pane,
            "document" => ControlType.Document,
            "list" => ControlType.List,
            "listitem" => ControlType.ListItem,
            "combobox" => ControlType.ComboBox,
            "checkbox" => ControlType.CheckBox,
            "radiobutton" => ControlType.RadioButton,
            "tab" => ControlType.Tab,
            "tabitem" => ControlType.TabItem,
            "menuitem" => ControlType.MenuItem,
            "treeitem" => ControlType.TreeItem,
            "dataitem" => ControlType.DataItem,
            "slider" => ControlType.Slider,
            _ => throw new ControlException("CONTROL_TYPE_INVALID", $"Unsupported control type: {value}"),
        };
    }

    private static AutomationElement Focus(AutomationElement window)
    {
        var handle = WindowHandle(window);
        RestoreAndForeground(handle);
        return window;
    }

    private static object Click(AutomationElement window, Selector? selector, bool allowInputInjection)
    {
        var element = FindRequiredElement(window, selector);
        if (TryGetPattern(element, InvokePattern.Pattern, out InvokePattern? invoke))
        {
            try
            {
                invoke!.Invoke();
                return ElementInfo.FromElement(element, includeValue: false);
            }
            catch when (allowInputInjection)
            {
                // Fall through to an explicit, foreground-checked mouse input.
            }
        }

        if (TryGetPattern(element, SelectionItemPattern.Pattern, out SelectionItemPattern? selectionItem))
        {
            try
            {
                selectionItem!.Select();
                return ElementInfo.FromElement(element, includeValue: false);
            }
            catch when (allowInputInjection)
            {
                // Fall through to an explicit, foreground-checked mouse input.
            }
        }

        if (!allowInputInjection)
            throw new ControlException("INPUT_INJECTION_REQUIRED", "The element has no invokable UI Automation pattern.");
        InjectClick(WindowHandle(window), element);
        return ElementInfo.FromElement(element, includeValue: false);
    }

    private static object TypeText(AutomationElement window, Selector? selector, string? text, bool allowInputInjection)
    {
        if (text is null) throw new ControlException("TEXT_REQUIRED", "Text is required.");
        var element = FindRequiredElement(window, selector);
        if (element.Current.IsPassword)
            throw new ControlException("SENSITIVE_INPUT_BLOCKED", "Password controls cannot be automated.");

        if (TryGetPattern(element, ValuePattern.Pattern, out ValuePattern? valuePattern)
            && !valuePattern!.Current.IsReadOnly)
        {
            try
            {
                valuePattern!.SetValue(text);
                return ElementInfo.FromElement(element, includeValue: false);
            }
            catch when (allowInputInjection)
            {
                // Fall through to foreground-checked keyboard input.
            }
        }

        if (!allowInputInjection)
            throw new ControlException("INPUT_INJECTION_REQUIRED", "The element has no writable UI Automation value pattern.");
        RestoreAndForeground(WindowHandle(window));
        element.SetFocus();
        SendUnicodeText(text);
        return ElementInfo.FromElement(element, includeValue: false);
    }

    private static object ReadValue(AutomationElement window, Selector? selector)
    {
        var element = FindRequiredElement(window, selector);
        if (element.Current.IsPassword)
            throw new ControlException("SENSITIVE_READ_BLOCKED", "Password controls cannot be read.");

        var value = "";
        if (TryGetPattern(element, ValuePattern.Pattern, out ValuePattern? valuePattern))
        {
            value = valuePattern!.Current.Value;
        }
        else if (TryGetPattern(element, TextPattern.Pattern, out TextPattern? textPattern))
        {
            value = textPattern!.DocumentRange.GetText(2000).TrimEnd('\0');
        }
        else if (TryGetPattern(element, SelectionPattern.Pattern, out SelectionPattern? selectionPattern))
        {
            try
            {
                value = string.Join(", ", selectionPattern!.Current.GetSelection()
                    .Cast<AutomationElement>()
                    .Select(selected => selected.Current.Name)
                    .Where(name => !string.IsNullOrWhiteSpace(name)));
            }
            catch
            {
                value = "";
            }
        }
        else
        {
            value = element.Current.Name ?? "";
        }
        return new { value = value.Length > 2000 ? value[..2000] : value, element = ElementInfo.FromElement(element, includeValue: false) };
    }

    private static object PressKey(AutomationElement window, string? key, bool allowInputInjection)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ControlException("KEY_REQUIRED", "A key is required.");
        if (!allowInputInjection) throw new ControlException("INPUT_INJECTION_REQUIRED", "Key input requires explicit approval.");
        var hwnd = WindowHandle(window);
        RestoreAndForeground(hwnd);
        SendKeySequence(key);
        return new { hwnd = hwnd.ToInt64(), key };
    }

    private static object Scroll(AutomationElement window, string? direction, Selector? selector, bool allowInputInjection)
    {
        var down = string.Equals(direction, "down", StringComparison.OrdinalIgnoreCase);
        if (!down && !string.Equals(direction, "up", StringComparison.OrdinalIgnoreCase))
            throw new ControlException("DIRECTION_REQUIRED", "Scroll direction must be up or down.");

        var element = selector is null ? window : FindSingle(window, selector);
        if (TryGetPattern(element, ScrollPattern.Pattern, out ScrollPattern? scrollPattern))
        {
            scrollPattern!.Scroll(
                ScrollAmount.NoAmount,
                down ? ScrollAmount.SmallIncrement : ScrollAmount.SmallDecrement);
            return ElementInfo.FromElement(element, includeValue: false);
        }
        if (!allowInputInjection) throw new ControlException("INPUT_INJECTION_REQUIRED", "The element has no scroll UI Automation pattern.");
        InjectWheel(WindowHandle(window), down ? -3 : 3);
        return WindowInfo.FromElement(window);
    }

    private static AutomationElement FindRequiredElement(AutomationElement window, Selector? selector)
    {
        if (selector is null) throw new ControlException("ELEMENT_REQUIRED", "A UI Automation element selector is required.");
        return FindSingle(window, selector);
    }

    private static bool TryGetPattern<T>(AutomationElement element, AutomationPattern pattern, out T? value)
        where T : class
    {
        value = null;
        try
        {
            if (!element.TryGetCurrentPattern(pattern, out var raw)) return false;
            value = raw as T;
            return value is not null;
        }
        catch
        {
            return false;
        }
    }

    private static IntPtr WindowHandle(AutomationElement element)
    {
        var hwnd = new IntPtr(element.Current.NativeWindowHandle);
        if (hwnd == IntPtr.Zero) throw new ControlException("WINDOW_HANDLE_UNAVAILABLE", "The target element has no window handle.");
        return hwnd;
    }

    private static void RestoreAndForeground(IntPtr hwnd)
    {
        ShowWindow(hwnd, ShowWindowRestore);
        SetForegroundWindow(hwnd);
        Thread.Sleep(50);
        if (GetForegroundWindow() != hwnd)
            throw new ControlException("WINDOW_NOT_FOREGROUND", "The target window could not be brought to the foreground.");
    }

    private static void InjectClick(IntPtr window, AutomationElement element)
    {
        RestoreAndForeground(window);
        var rect = element.Current.BoundingRectangle;
        if (rect.Width <= 0 || rect.Height <= 0) throw new ControlException("ELEMENT_BOUNDS_INVALID", "The target element has no usable bounds.");
        SetCursorPos((int)(rect.Left + rect.Width / 2), (int)(rect.Top + rect.Height / 2));
        SendInputs(new[] { MouseInput(MouseLeftDown), MouseInput(MouseLeftUp) });
    }

    private static void InjectWheel(IntPtr window, int notches)
    {
        RestoreAndForeground(window);
        if (!GetWindowRect(window, out var rect)) throw new ControlException("WINDOW_BOUNDS_UNAVAILABLE", "The target window bounds are unavailable.");
        SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
        var inputs = new List<INPUT>();
        var direction = notches > 0 ? MouseWheelDelta : -MouseWheelDelta;
        for (var index = 0; index < Math.Abs(notches); index++) inputs.Add(MouseInput(MouseWheel, direction));
        SendInputs(inputs.ToArray());
    }

    private static object Screenshot(AutomationElement window, string? outputPath)
    {
        if (string.IsNullOrWhiteSpace(outputPath)) throw new ControlException("OUTPUT_PATH_REQUIRED", "A screenshot output path is required.");
        var hwnd = WindowHandle(window);
        if (!GetWindowRect(hwnd, out var rect)) throw new ControlException("WINDOW_BOUNDS_UNAVAILABLE", "The target window bounds are unavailable.");
        var width = Math.Max(1, rect.Right - rect.Left);
        var height = Math.Max(1, rect.Bottom - rect.Top);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
        using var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        var captured = false;
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var hdc = graphics.GetHdc();
            try { captured = PrintWindow(hwnd, hdc, PrintWindowFullContent); }
            finally { graphics.ReleaseHdc(hdc); }
        }
        if (!captured)
        {
            using var graphics = Graphics.FromImage(bitmap);
            graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
        }
        bitmap.Save(outputPath, ImageFormat.Png);
        return new { hwnd = hwnd.ToInt64(), path = outputPath };
    }

    private static void SendUnicodeText(string text)
    {
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (var character in text)
        {
            inputs.Add(KeyInput(0, character, KeyUnicode));
            inputs.Add(KeyInput(0, character, KeyUnicode | KeyUp));
        }
        if (inputs.Count > 0) SendInputs(inputs.ToArray());
    }

    private static void SendKeySequence(string value)
    {
        var parts = value.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) throw new ControlException("KEY_INVALID", "Key sequence is empty.");
        var modifiers = new List<ushort>();
        foreach (var part in parts[..^1]) modifiers.Add(ParseVirtualKey(part));
        var key = ParseVirtualKey(parts[^1]);
        var inputs = new List<INPUT>();
        foreach (var modifier in modifiers) inputs.Add(KeyInput(modifier, 0, 0));
        inputs.Add(KeyInput(key, 0, 0));
        inputs.Add(KeyInput(key, 0, KeyUp));
        for (var index = modifiers.Count - 1; index >= 0; index--) inputs.Add(KeyInput(modifiers[index], 0, KeyUp));
        SendInputs(inputs.ToArray());
    }

    private static ushort ParseVirtualKey(string value)
    {
        var normalized = value.Trim().ToUpperInvariant();
        if (normalized.Length == 1 && normalized[0] >= 'A' && normalized[0] <= 'Z') return normalized[0];
        if (normalized.Length == 1 && normalized[0] >= '0' && normalized[0] <= '9') return normalized[0];
        return normalized switch
        {
            "CTRL" or "CONTROL" => 0x11,
            "ALT" => 0x12,
            "SHIFT" => 0x10,
            "WIN" or "WINDOWS" => 0x5B,
            "ENTER" or "RETURN" => 0x0D,
            "TAB" => 0x09,
            "ESC" or "ESCAPE" => 0x1B,
            "SPACE" => 0x20,
            "BACKSPACE" => 0x08,
            "DELETE" or "DEL" => 0x2E,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" => 0x21,
            "PAGEDOWN" => 0x22,
            "ARROWUP" or "UP" => 0x26,
            "ARROWDOWN" or "DOWN" => 0x28,
            "ARROWLEFT" or "LEFT" => 0x25,
            "ARROWRIGHT" or "RIGHT" => 0x27,
            _ => throw new ControlException("KEY_INVALID", $"Unsupported key: {value}"),
        };
    }

    private static void SendInputs(INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        if (sent != (uint)inputs.Length) throw new ControlException("INPUT_INJECTION_BLOCKED", "Windows blocked the requested input.");
    }

    private static INPUT KeyInput(ushort key, ushort scan, uint flags) => new()
    {
        Type = InputKeyboard,
        Union = new InputUnion { Keyboard = new KEYBDINPUT { VirtualKey = key, ScanCode = scan, Flags = flags } },
    };

    private static INPUT MouseInput(uint flags, int data = 0) => new()
    {
        Type = InputMouse,
        Union = new InputUnion { Mouse = new MOUSEINPUT { Flags = flags, MouseData = data } },
    };

    private sealed class ControlException(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    private sealed class Request
    {
        [JsonPropertyName("id")] public string? Id { get; init; }
        [JsonPropertyName("action")] public string? Action { get; init; }
        [JsonPropertyName("hwnd")] public long? Hwnd { get; init; }
        [JsonPropertyName("element")] public Selector? Element { get; init; }
        [JsonPropertyName("text")] public string? Text { get; init; }
        [JsonPropertyName("key")] public string? Key { get; init; }
        [JsonPropertyName("direction")] public string? Direction { get; init; }
        [JsonPropertyName("outputPath")] public string? OutputPath { get; init; }
        [JsonPropertyName("allowInputInjection")] public bool AllowInputInjection { get; init; }
        [JsonPropertyName("auditPath")] public string? AuditPath { get; init; }
    }

    private sealed class Selector
    {
        [JsonPropertyName("name")] public string? Name { get; init; }
        [JsonPropertyName("automationId")] public string? AutomationId { get; init; }
        [JsonPropertyName("controlType")] public string? ControlType { get; init; }
        [JsonPropertyName("index")] public int? Index { get; init; }
    }

    private sealed class Response
    {
        [JsonPropertyName("id")] public string? Id { get; init; }
        [JsonPropertyName("ok")] public bool Ok { get; init; }
        [JsonPropertyName("result")] public object? Result { get; init; }
        [JsonPropertyName("error")] public Error? ErrorInfo { get; init; }

        public static Response Success(string? id, object result) => new() { Id = id, Ok = true, Result = result };
        public static Response Error(string? id, string code, string message) => new()
        {
            Id = id,
            Ok = false,
            ErrorInfo = new Error { Code = code, Message = message },
        };
    }

    private sealed class Error
    {
        [JsonPropertyName("code")] public string Code { get; init; } = "COMPUTER_ERROR";
        [JsonPropertyName("message")] public string Message { get; init; } = "Computer control failed.";
    }

    private sealed class WindowInfo
    {
        [JsonPropertyName("hwnd")] public long Hwnd { get; init; }
        [JsonPropertyName("title")] public string Title { get; init; } = "";
        [JsonPropertyName("processId")] public int? ProcessId { get; init; }
        [JsonPropertyName("processName")] public string? ProcessName { get; init; }
        [JsonPropertyName("focused")] public bool Focused { get; init; }
        [JsonPropertyName("visible")] public bool Visible { get; init; }
        [JsonPropertyName("bounds")] public Bounds? Bounds { get; init; }

        public static WindowInfo FromElement(AutomationElement element)
        {
            var hwnd = new IntPtr(element.Current.NativeWindowHandle);
            var processId = element.Current.ProcessId;
            string? processName = null;
            try { processName = Process.GetProcessById(processId).ProcessName; } catch { }
            Bounds? bounds = null;
            if (hwnd != IntPtr.Zero && GetWindowRect(hwnd, out var rect)) bounds = Bounds.FromRect(rect);
            return new WindowInfo
            {
                Hwnd = hwnd.ToInt64(),
                Title = element.Current.Name ?? "",
                ProcessId = processId > 0 ? processId : null,
                ProcessName = processName,
                Focused = hwnd != IntPtr.Zero && GetForegroundWindow() == hwnd,
                Visible = hwnd != IntPtr.Zero && IsWindowVisible(hwnd),
                Bounds = bounds,
            };
        }
    }

    private sealed class ElementInfo
    {
        [JsonPropertyName("name")] public string Name { get; init; } = "";
        [JsonPropertyName("automationId")] public string AutomationId { get; init; } = "";
        [JsonPropertyName("controlType")] public string ControlType { get; init; } = "";
        [JsonPropertyName("hwnd")] public long Hwnd { get; init; }
        [JsonPropertyName("enabled")] public bool Enabled { get; init; }
        [JsonPropertyName("value")] public string? Value { get; set; }
        [JsonPropertyName("bounds")] public Bounds? Bounds { get; init; }
        [JsonPropertyName("children")] public ElementInfo[]? Children { get; set; }

        public static ElementInfo FromElement(AutomationElement element, bool includeValue)
        {
            var current = element.Current;
            var hwnd = new IntPtr(current.NativeWindowHandle);
            var result = new ElementInfo
            {
                Name = current.Name ?? "",
                AutomationId = current.AutomationId ?? "",
                ControlType = current.ControlType?.ProgrammaticName?.Replace("ControlType.", "") ?? "",
                Hwnd = hwnd.ToInt64(),
                Enabled = current.IsEnabled,
                Bounds = Bounds.FromRect(current.BoundingRectangle),
            };
            if (includeValue && !current.IsPassword) result.Value = TryReadValue(element);
            return result;
        }

        private static string? TryReadValue(AutomationElement element)
        {
            try
            {
                if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var raw) && raw is ValuePattern value)
                    return value.Current.Value;
            }
            catch { }
            return null;
        }
    }

    private sealed class Bounds
    {
        [JsonPropertyName("x")] public int X { get; init; }
        [JsonPropertyName("y")] public int Y { get; init; }
        [JsonPropertyName("width")] public int Width { get; init; }
        [JsonPropertyName("height")] public int Height { get; init; }

        public static Bounds FromRect(Rectangle rect) => new() { X = rect.X, Y = rect.Y, Width = rect.Width, Height = rect.Height };
        public static Bounds FromRect(System.Windows.Rect rect) => new() { X = (int)rect.X, Y = (int)rect.Y, Width = (int)rect.Width, Height = (int)rect.Height };
        public static Bounds FromRect(RECT rect) => new() { X = rect.Left, Y = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top };
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint Type;
        public InputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT Mouse;
        [FieldOffset(0)] public KEYBDINPUT Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int X;
        public int Y;
        public int MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseWheel = 0x0800;
    private const int MouseWheelDelta = 120;
    private const uint KeyUp = 0x0002;
    private const uint KeyUnicode = 0x0004;
    private const int ShowWindowRestore = 9;
    private const uint PrintWindowFullContent = 2;

    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
}
