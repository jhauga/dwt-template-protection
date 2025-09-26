# Dreamweaver Template Protection

This VS Code extension brings robust protection for files using the Dreamweaver Template (`.dwt`) syntax to your modern development workflow. It prevents accidental edits to locked, non-editable regions by visually distinguishing them and enforcing read-only behavior.

## Features

- **🔒 True Edit Prevention**: Changes to protected regions are instantly reverted.
- **🎨 Visual Cues**: Non-editable regions can be highlighted; editable regions remain normal (configurable).
- **⚙️ Automatic Detection**: Detects Dreamweaver-style editable markers.
- **📋 Region Navigation**: `Show Editable Regions` lists and jumps to editables.
- **📦 Safe Template Sync**: Updates `.html`/`.php` instance files based on `.dwt` while surgically preserving editable content.
- **🧪 Diff & Batch Apply**: Interactive Apply / Apply to All / Preview Diff / Skip flow.
- **🧬 Repeat Entry Duplication**: Insert repeat entries before/after current selection.
- **🌓 Alternating Row Colors**: Enforces `<tr bgcolor="@@(_index & 1 ? '#FFFFFF' : '#CCCCCC')@@">` style ternary from template into instance repeat rows.
- **🛡️ Per-File Protection Toggle**: Right‑click to Turn On / Turn Off protection per file (no global toggle clutter).

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

- Dreamweaver Template: Show Editable Regions
- Dreamweaver Template: Update HTML Based on Template (on `.dwt`)
- Dreamweaver Template: Find Template Instances (on `.dwt`)
- Dreamweaver Template: Restore Last HTML Backup
- Dreamweaver Template: Insert Entry After Selection (inside repeat)
- Dreamweaver Template: Insert Entry Before Selection (inside repeat)
- Dreamweaver Template: Turn Off Protection (per active instance file)
- Dreamweaver Template: Turn On Protection (per active instance file)

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

## Alternating Row Background Enforcement

If your template repeat block contains a ternary Dreamweaver expression for a row background color:

```html
<!-- TemplateBeginRepeat name="Table1" -->
<tr bgcolor="@@(_index & 1 ? '#FFFFFF' : '#CCCCCC')@@">
    ... editable cells ...
</tr>
<!-- TemplateEndRepeat -->
```

Then during template synchronization each corresponding instance repeat entry (`<!-- InstanceBeginRepeat name="Table1" --> ... <!-- InstanceEndRepeat -->`) has the first `<tr ... bgcolor="#XXXXXX">` in each repeat entry normalized to alternate colors according to index:

- `_index & 1` truthy (odd) → first color (`#FFFFFF`)
- `_index & 1` falsy (even) → second color (`#CCCCCC`)

Manual adjustments (including comment markers like `<!-- EDIT - mind alternating bgcolor -->` or `<!-- GOAL - ... -->`) will have only the bgcolor attribute corrected; the rest of the content remains intact.

Only repeat blocks whose template source contains the exact ternary pattern are modified; other rows are untouched.