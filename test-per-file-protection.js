// Test Per-File Protection Toggle
// Run this test to verify that protection can be enabled/disabled per file

const vscode = require('vscode');
const fs = require('fs');

async function testPerFileProtection() {
    console.log('Testing per-file protection toggle...');
    
    // 1. Open about.html
    const aboutUri = vscode.Uri.file('d:/Users/johnh/Documents/GitHub/dwt-template-protection/site/about.html');
    const aboutDoc = await vscode.workspace.openTextDocument(aboutUri);
    const aboutEditor = await vscode.window.showTextDocument(aboutDoc);
    
    // Wait for decorations to be applied
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('✓ Opened about.html');
    
    // 2. Try to turn off protection for this file only
    await vscode.commands.executeCommand('dreamweaverTemplate.turnOffProtection');
    console.log('✓ Executed turn off protection command');
    
    // 3. Open contact.html in another tab
    const contactUri = vscode.Uri.file('d:/Users/johnh/Documents/GitHub/dwt-template-protection/site/contact.html');
    const contactDoc = await vscode.workspace.openTextDocument(contactUri);
    const contactEditor = await vscode.window.showTextDocument(contactDoc);
    
    console.log('✓ Opened contact.html in another tab');
    
    // 4. Verify that contact.html still has protection (should show decorations/protection)
    // 5. Switch back to about.html and verify protection is off
    await vscode.window.showTextDocument(aboutDoc);
    console.log('✓ Switched back to about.html');
    
    // 6. Turn protection back on for about.html
    await vscode.commands.executeCommand('dreamweaverTemplate.turnOnProtection');
    console.log('✓ Executed turn on protection command');
    
    console.log('✅ Per-file protection test completed!');
    console.log('');
    console.log('Manual verification steps:');
    console.log('1. Notice that only the active file protection is toggled');
    console.log('2. Other open files maintain their protection state');
    console.log('3. Check the status bar or try editing protected regions');
}

// Export for manual execution
module.exports = { testPerFileProtection };

// If running directly, execute the test
if (require.main === module) {
    testPerFileProtection().catch(console.error);
}