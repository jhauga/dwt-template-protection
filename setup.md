# Dreamweaver Template Protection - Developer Setup

This document outlines the steps to set up a local development environment for the extension.

## Prerequisites

-   [Node.js](https://nodejs.org/) (version 16 or higher)
-   [Visual Studio Code](https://code.visualstudio.com/)

## Setup Steps

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/YinsPeace/dwt-template-protection.git
    cd dwt-template-protection
    ```

2.  **Install Dependencies**
    Install the project dependencies using npm.
    ```bash
    npm install
    ```

3.  **Compile the Extension**
    The extension is written in TypeScript and needs to be compiled to JavaScript.
    ```bash
    npm run compile
    ```
    You can also run `npm run watch` to automatically recompile the extension whenever you save a file in the `src` directory.

## Testing the Extension

1.  **Launch the Development Host**
    -   Open the project folder (`dwt-template-protection`) in VS Code.
    -   Press `F5` to open a new "Extension Development Host" window. This window runs your extension's code.

2.  **Test the Features**
    -   In the new window, open a file that uses Dreamweaver template syntax (e.g., `.html`, `.php`).
    -   Verify the following behavior:
        -   **Protected regions** (code outside of `<!-- InstanceBeginEditable -->` blocks) should appear "grayed out" with reduced opacity.
        -   **Editable regions** should have no special styling.
        -   Attempting to type in a **protected region** should result in the change being immediately undone.
        -   The `Dreamweaver Template: Show Editable Regions` command should list the editable blocks.
        -   The `Dreamweaver Template: Toggle Protection` command should enable/disable the gray-out effect and edit prevention.

## Packaging the Extension

To create a `.vsix` file for distribution:

```bash
# Install the vsce packaging tool globally (if you haven't already)
npm install -g vsce

# Package the extension
vsce package
```
This will create a `dwt-template-protection-x.x.x.vsix` file in your project directory.