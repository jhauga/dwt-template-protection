/*
 Guided Walkthrough for Dreamweaver Template Protection Testing
 This script provides step-by-step guidance with detailed status tracking
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..');
const siteRoot = path.join(repoRoot, 'site');
const templatesDir = path.join(siteRoot, 'Templates');

function runCmd(cmd, args, opts = {}) {
  return cp.spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, shell: false, ...opts });
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function statusCheck(description, checkFn) {
  const result = checkFn();
  const status = result ? '✓ PASS' : '✗ FAIL';
  console.log(`   ${status}: ${description}`);
  return result;
}

function fileExists(filePath, description) {
  return statusCheck(description, () => exists(filePath));
}

function folderExists(folderPath, description) {
  return statusCheck(description, () => exists(folderPath) && fs.statSync(folderPath).isDirectory());
}

function extensionReady() {
  console.log('\n🔍 CHECKING EXTENSION STATUS:');
  console.log('   - VS Code should be open with this workspace');
  console.log('   - Extension should be loaded (press F5 if not debugging)');
  console.log('   - Right-click menu should show "Update HTML Based on Template" on .dwt files');
  return true;
}

async function waitForUserAction(stepName, instructions) {
  console.log(`\n📋 ${stepName}:`);
  instructions.forEach(instr => console.log(`   ${instr}`));
  await prompt('\n⏸️  Press Enter when you have completed this step...');
}

async function main() {
  console.log('🚀 GUIDED WALKTHROUGH: Dreamweaver Template Protection Test\n');
  
  // Pre-flight checks
  console.log('🔍 PRE-FLIGHT CHECKS:');
  fileExists(path.join(repoRoot, 'site.zip'), 'Backup site.zip exists');
  fileExists(path.join(templatesDir, 'page.dwt'), 'Templates/page.dwt exists');
  folderExists(siteRoot, 'Site folder exists');
  extensionReady();
  
  console.log('\n📝 TEST PLAN OVERVIEW:');
  console.log('   1. Backup current site');
  console.log('   2. Modify page.dwt (add Test menu item)');
  console.log('   3. Create test.html instance');
  console.log('   4. Update page.dwt instances via VS Code');
  console.log('   5. Update child templates via VS Code');
  console.log('   6. Inject test content into editable regions');
  console.log('   7. Verify all changes are as expected');
  console.log('   8. Clean up and restore');
  
  await prompt('\n▶️  Press Enter to begin the test...');
  
  console.log('\n🎯 STEP 1: BACKUP AND PREPARATION');
  console.log('Running save.bat to backup current site...');
  let r = runCmd('cmd', ['/c', 'save.bat']);
  statusCheck('save.bat executed successfully', () => r.status === 0);
  
  console.log('\n🎯 STEP 2: RUNNING AUTOMATED TEST HARNESS');
  console.log('Starting test harness...');
  r = runCmd('cmd', ['/c', 'npm', 'run', 'test:dw'], { stdio: 'inherit' });
  statusCheck('Test harness completed', () => r.status === 0);
  
  console.log('\n🎯 STEP 3: POST-TEST VERIFICATION');
  
  // Check if log file was created
  const logDir = path.join(repoRoot, '.test-log');
  if (exists(logDir)) {
    const logFiles = fs.readdirSync(logDir).filter(f => f.startsWith('log_'));
    if (logFiles.length > 0) {
      const latestLog = logFiles[logFiles.length - 1];
      console.log(`\n📊 LATEST LOG FILE: ${latestLog}`);
      const logContent = fs.readFileSync(path.join(logDir, latestLog), 'utf8');
      const lines = logContent.split('\n');
      
      // Extract key results
      const navPassed = lines.some(l => l.includes('Nav verification passed'));
      const childPassed = lines.some(l => l.includes('Child template verification passed'));
      const paraPassed = lines.some(l => l.includes('Paragraph verification passed'));
      
      console.log('\n🔍 TEST RESULTS SUMMARY:');
      statusCheck('Navigation menu update verification', () => navPassed);
      statusCheck('Child template update verification', () => childPassed);
      statusCheck('Paragraph injection verification', () => paraPassed);
      
      const allPassed = navPassed && childPassed && paraPassed;
      console.log(`\n🎉 OVERALL RESULT: ${allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}`);
      
      if (!allPassed) {
        console.log('\n📄 Full log content:');
        console.log('─'.repeat(60));
        console.log(logContent);
        console.log('─'.repeat(60));
      }
    }
  }
  
  // Check site restoration
  console.log('\n🔍 SITE RESTORATION CHECK:');
  const testHtmlExists = exists(path.join(siteRoot, 'test.html'));
  statusCheck('test.html removed (site restored)', () => !testHtmlExists);
  
  const diffFolderExists = exists(path.join(repoRoot, 'diff'));
  statusCheck('diff folder cleaned up', () => !diffFolderExists);
  
  console.log('\n✅ WALKTHROUGH COMPLETE!');
  console.log('🔄 You can run this again with: npm run test:guided');
}

main().catch(err => {
  console.error('❌ ERROR:', err.message);
  process.exit(1);
});