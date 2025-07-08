# Dreamweaver Template Protection

This VS Code extension brings robust protection for files using the Dreamweaver Template (`.dwt`) syntax to your modern development workflow. It prevents accidental edits to locked, non-editable regions by visually distinguishing them and enforcing read-only behavior.

## Features

-   **🔒 True Edit Prevention**: Any changes made to protected regions are automatically and instantly undone.
-   **🎨 Subtle Visual Cues**: Instead of intrusive colors, non-editable regions are simply "grayed out" with reduced opacity, making it easy to see what's locked without distracting you. Editable regions have no special styling.
-   **⚙️ Automatic Detection**: Works out-of-the-box with files using Dreamweaver's `<!-- InstanceBeginEditable -->` comment syntax.
-   **🎯 Smart Navigation**: Use the `Dreamweaver Template: Show Editable Regions` command to quickly list and jump to any editable section in the file.
-   **✅ On-Demand Control**: Easily enable or disable the protection for the active file using the `Dreamweaver Template: Toggle Protection` command.

## How It Works

The extension parses your files for standard Dreamweaver template comments to identify editable regions:

```html
<!-- This area is protected -->
<title>My Page</title>
<!-- This area is also protected -->

<!-- InstanceBeginEditable name="content" -->
    <!-- This area is editable -->
    <div>You can make changes here.</div>
<!-- InstanceEndEditable -->

<!-- This final area is protected -->
```

## Commands

-   **Dreamweaver Template: Show Editable Regions**: Displays a list of all editable regions for quick navigation.
-   **Dreamweaver Template: Toggle Protection**: Enables or disables template protection for the current file.

## Supported File Types

The extension activates for a wide range of file types that commonly use this template style, including:
- `.html`
- `.htm`
- `.php`
- `.asp`
- `.csp`
- `.dwt`

## Configuration

You can configure the extension's behavior via `File > Preferences > Settings > Extensions > Dreamweaver Template Protection`:

-   **Enable Protection** (default: `true`): Master toggle for all features.
-   **Highlight Protected Regions** (default: `true`): Controls whether non-editable regions are grayed out.