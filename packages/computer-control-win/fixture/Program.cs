using System.Drawing;
using System.Windows.Forms;

namespace YoomClaw.ComputerControl.Fixture;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        using var form = new Form
        {
            Name = "yoomclawFixtureWindow",
            Text = "YoomClaw Computer Control Fixture",
            StartPosition = FormStartPosition.CenterScreen,
            ClientSize = new Size(480, 240),
            MinimizeBox = false,
            MaximizeBox = false,
        };

        var layout = new TableLayoutPanel
        {
            Name = "fixtureLayout",
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            ColumnCount = 2,
            RowCount = 5,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 120));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var index = 0; index < layout.RowCount; index++)
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, index == 3 ? 70 : 34));

        var inputLabel = new Label
        {
            Name = "fixtureInputLabel",
            AccessibleName = "Name",
            Text = "Name",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
        };
        var input = new TextBox
        {
            Name = "fixtureInput",
            AccessibleName = "Name input",
            Dock = DockStyle.Fill,
        };

        var apply = new Button
        {
            Name = "fixtureApply",
            AccessibleName = "Apply",
            Text = "Apply",
            AutoSize = true,
        };

        var statusLabel = new Label
        {
            Name = "fixtureStatusLabel",
            AccessibleName = "Status",
            Text = "Status",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
        };
        var status = new TextBox
        {
            Name = "fixtureStatus",
            AccessibleName = "Status value",
            ReadOnly = true,
            Dock = DockStyle.Fill,
            Text = "Idle",
        };

        var choiceLabel = new Label
        {
            Name = "fixtureChoiceLabel",
            AccessibleName = "Choice",
            Text = "Choice",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
        };
        var choice = new ListBox
        {
            Name = "fixtureChoice",
            AccessibleName = "Choice",
            Dock = DockStyle.Fill,
            SelectionMode = SelectionMode.One,
        };
        choice.Items.AddRange(["One", "Two", "Three"]);
        choice.SelectedIndex = 0;

        apply.Click += (_, _) => status.Text = $"Hello {input.Text}";

        layout.Controls.Add(inputLabel, 0, 0);
        layout.Controls.Add(input, 1, 0);
        layout.Controls.Add(apply, 1, 1);
        layout.Controls.Add(statusLabel, 0, 2);
        layout.Controls.Add(status, 1, 2);
        layout.Controls.Add(choiceLabel, 0, 3);
        layout.Controls.Add(choice, 1, 3);
        layout.Controls.Add(new Label
        {
            Name = "fixtureHint",
            Text = "Only this fixture window may be automated.",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
        }, 1, 4);
        form.Controls.Add(layout);
        Application.Run(form);
    }
}
