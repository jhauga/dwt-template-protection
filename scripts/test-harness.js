/*
 End-to-end test harness for Dreamweaver Template Protection
 Steps automated per user request:
 1) Run save.bat to snapshot site.zip
 2) Modify Templates/page.dwt to add a menu item for /test.html
 3) Create site/test.html instance based on page.dwt
 4) Prompt user to run the VS Code command "Update HTML Based on Template" on page.dwt, then press Enter
 5) Restore baseline into diff folder (reset.bat diff) and verify only nav change across instances of page.dwt
 6) Prompt user to update child templates of page.dwt, then verify only nav change across their instances
 7) Inject <p>Test</p> into first editable region of all non-template html/php files, verify only that change
 8) Write a concise log under .test-log
 9) Restore live site from site.zip (reset.bat)
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..');
const siteRoot = path.join(repoRoot, 'site');
const templatesDir = path.join(siteRoot, 'Templates');
const backupDirName = '.dwt-template-protection-backups';

function runCmd(cmd, args, opts = {}) {
  return cp.spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, shell: false, ...opts });
}

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, 'utf8'); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function normalizeLF(s) { return s.replace(/\r\n?/g, '\n'); }

function addMenuItemToPageDwt() {
  const p = path.join(templatesDir, 'page.dwt');
  if (!exists(p)) throw new Error('Templates/page.dwt not found');
  let txt = read(p);
  if (txt.includes('/test.html')) return false; // already added
  const navUlEnd = txt.indexOf('</ul>');
  // Insert before Contact link when possible
  const contactIdx = txt.indexOf('<li><a href="/contact.html"');
  const insertHtml = '    <li><a href="/test.html">Test</a></li>\n';
  if (contactIdx !== -1) {
    const before = txt.slice(0, contactIdx);
    const after = txt.slice(contactIdx);
    txt = before + insertHtml + after;
  } else if (navUlEnd !== -1) {
    txt = txt.slice(0, navUlEnd) + insertHtml + txt.slice(navUlEnd);
  } else {
    // fallback append near nav
    txt += '\n' + insertHtml + '\n';
  }
  write(p, txt);
  return true;
}

function makeInstanceFromTemplate(templatePath, outPath) {
  const raw = normalizeLF(read(templatePath));
  // Convert TemplateBeginEditable to InstanceBeginEditable keeping content
  let body = raw.replace(/<!--\s*TemplateBeginEditable\s+name="([^"]+)"\s*-->/g, '<!-- InstanceBeginEditable name="$1" -->')
                .replace(/<!--\s*TemplateEndEditable\s*-->/g, '<!-- InstanceEndEditable -->');
  // Remove any existing InstanceBegin to avoid duplicates
  body = body.replace(/<!--\s*InstanceBegin[^>]*-->/gi, '');
  // Inject InstanceBegin after <html>
  const htmlMatch = body.match(/<html[^>]*>/i);
  const instanceBegin = `<!-- InstanceBegin template="/Templates/${path.basename(templatePath)}" codeOutsideHTMLIsLocked="true" -->`;
  if (htmlMatch) {
    body = body.replace(htmlMatch[0], htmlMatch[0] + '\n' + instanceBegin);
  } else {
    body = instanceBegin + '\n' + body;
  }
  // Ensure InstanceEnd before </html>
  body = body.replace(/<!--\s*InstanceEnd\s*-->/gi, '');
  body = body.replace(/<\/html>/i, '<!-- InstanceEnd --></html>');
  write(outPath, body);
}

function listAllFiles(dir, filterFn) {
  const out = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === backupDirName) continue;
        walk(full);
      } else {
        if (!filterFn || filterFn(full)) out.push(full);
      }
    }
  })(dir);
  return out;
}

function findInstancesOfTemplate(templateBasename) {
  const htmls = listAllFiles(siteRoot, p => /\.(html|php)$/i.test(p) && !p.includes('Templates'));
  const res = [];
  for (const f of htmls) {
    try {
      const head = read(f).slice(0, 600);
      const m = head.match(/<!--\s*InstanceBegin\s+template="([^"]+)"/i);
      if (m && path.basename(m[1]) === templateBasename) res.push(f);
    } catch {}
  }
  return res;
}

function findChildTemplatesOf(parentTemplatePath) {
  const parentBase = path.basename(parentTemplatePath);
  const dwtFiles = listAllFiles(templatesDir, p => /\.dwt$/i.test(p));
  return dwtFiles.filter(p => p !== parentTemplatePath && (() => {
    const head = read(p).slice(0, 600);
    const m = head.match(/<!--\s*InstanceBegin\s+template="([^"]+)"/i);
    return !!(m && path.basename(m[1]) === parentBase);
  })());
}

function compareText(a, b) {
  if (a === b) return { equal: true, diffs: [] };
  const al = normalizeLF(a).split('\n');
  const bl = normalizeLF(b).split('\n');
  const max = Math.max(al.length, bl.length);
  const diffs = [];
  for (let i = 0; i < max; i++) {
    const la = al[i] ?? '';
    const lb = bl[i] ?? '';
    if (la !== lb) diffs.push({ line: i + 1, a: la, b: lb });
  }
  return { equal: diffs.length === 0, diffs };
}

function onlyMenuChange(diff, siteText, baselineText) {
  // Accept if removing lines containing '/test.html' (case-insensitive) makes files equal
  const stripMenu = s => normalizeLF(s).split('\n').filter(l => !/\/test\.html/i.test(l)).join('\n');
  return stripMenu(siteText) === stripMenu(baselineText);
}

function injectParagraphInFirstEditable(filePath) {
  let t = normalizeLF(read(filePath));
  const beg = /<!--\s*InstanceBeginEditable\s+name="([^"]+)"\s*-->/ig;
  const end = /<!--\s*InstanceEndEditable\s*-->/ig;
  const mb = beg.exec(t);
  if (!mb) return false;
  end.lastIndex = beg.lastIndex;
  const me = end.exec(t);
  if (!me) return false;
  const insertPos = mb.index + mb[0].length;
  const already = t.slice(insertPos, me.index).includes('<p>Test</p>');
  if (already) return false;
  t = t.slice(0, insertPos) + '\n<p>Test</p>\n' + t.slice(insertPos);
  write(filePath, t);
  return true;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nextLogPath() {
  const dir = path.join(repoRoot, '.test-log');
  ensureDir(dir);
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const base = `log_${yyyy}-${mm}-${dd}_`;
  const existing = fs.readdirSync(dir).filter(n => n.startsWith(base));
  const next = String(existing.length + 1).padStart(2, '0');
  return path.join(dir, `${base}${next}.log`);
}

function generateRandomId() {
  return Math.random().toString(36).substring(2, 8);
}

function manageDiffFolder() {
  const diffPath = path.join(repoRoot, 'diff');
  const diffFolderExist = exists(diffPath);
  let backupDiffName = null;
  
  if (diffFolderExist) {
    backupDiffName = `diff_${generateRandomId()}`;
    const backupPath = path.join(repoRoot, backupDiffName);
    fs.renameSync(diffPath, backupPath);
  }
  
  return { diffFolderExist, backupDiffName };
}

function cleanupDiffFolder(diffFolderExist, backupDiffName) {
  const diffPath = path.join(repoRoot, 'diff');
  
  if (diffFolderExist && backupDiffName) {
    // Remove the test diff folder and restore original
    if (exists(diffPath)) {
      fs.rmSync(diffPath, { recursive: true, force: true });
    }
    const backupPath = path.join(repoRoot, backupDiffName);
    if (exists(backupPath)) {
      fs.renameSync(backupPath, diffPath);
    }
  } else {
    // Remove the test diff folder completely
    if (exists(diffPath)) {
      fs.rmSync(diffPath, { recursive: true, force: true });
    }
  }
}

async function main() {
  const logLines = [];
  const log = (...a) => { const s = a.join(' '); console.log(s); logLines.push(s); };

  // Manage existing diff folder
  log('Pre-test: Managing existing diff folder');
  const { diffFolderExist, backupDiffName } = manageDiffFolder();
  log(` - Existing diff folder: ${diffFolderExist}`);
  if (backupDiffName) log(` - Backed up to: ${backupDiffName}`);

  log('Step 1: Saving current site via save.bat');
  let r = runCmd('cmd', ['/c', 'save.bat']);
  if (r.status !== 0) { log('ERROR: save.bat failed'); process.exit(1); }

  log('Step 2: Adding menu item /test.html to Templates/page.dwt');
  const changed = addMenuItemToPageDwt();
  log(` - page.dwt modified: ${changed}`);

  log('Step 3: Creating site/test.html as instance of page.dwt');
  const pageTemplate = path.join(templatesDir, 'page.dwt');
  const testHtml = path.join(siteRoot, 'test.html');
  if (!exists(testHtml)) makeInstanceFromTemplate(pageTemplate, testHtml);
  log(' - test.html created');

  log('Step 4: Please switch to VS Code and run "Update HTML Based on Template" on Templates/page.dwt.');
  log('   INSTRUCTIONS:');
  log('   1. Press F5 in VS Code to start debugging session (if not already running)');
  log('   2. Open Templates/page.dwt in VS Code');
  log('   3. Right-click in the editor and select "Update HTML Based on Template"');
  log('   4. Follow the confirmation prompts (Apply to All recommended)');
  log('   5. Wait for the operation to complete');
  await prompt('   Press Enter here ONLY AFTER the VS Code update finishes...');

  log('Verifying: Resetting baseline into diff/ with reset.bat diff');
  r = runCmd('cmd', ['/c', 'reset.bat', 'diff']);
  if (r.status !== 0) { log('ERROR: reset.bat diff failed'); process.exit(1); }

  const instances = findInstancesOfTemplate('page.dwt');
  log(`Found ${instances.length} instance(s) of page.dwt to verify.`);
  let okNav = true;
  for (const f of instances) {
    const rel = path.relative(siteRoot, f);
    const baseline = path.join(repoRoot, 'diff', rel);
    if (!exists(baseline)) { log(` - ${rel}: OK (new file; baseline missing)`); continue; }
    const siteTxt = read(f);
    const baseTxt = read(baseline);
    const onlyMenu = onlyMenuChange(compareText(siteTxt, baseTxt), siteTxt, baseTxt);
    log(` - ${rel}: ${onlyMenu ? 'OK (only menu change)' : 'DIFF (unexpected changes)'}`);
    if (!onlyMenu) okNav = false;
  }
  if (!okNav) {
    log('Nav verification failed. Please inspect diffs.');
  } else {
    log('Nav verification passed.');
  }

  // Step 5: child templates update (manual), then verify
  const childTemplates = findChildTemplatesOf(pageTemplate);
  if (childTemplates.length > 0) {
    log(`Step 5: Update child templates (${childTemplates.length}) that reference page.dwt in VS Code.`);
    childTemplates.forEach(t => log(' -', path.relative(repoRoot, t)));
    log('   INSTRUCTIONS:');
    log('   1. In VS Code, open each of the above child templates');
    log('   2. Right-click and select "Update HTML Based on Template"');
    log('   3. Follow confirmation prompts for each template');
    log('   4. Complete all templates before continuing');
    await prompt('   Press Enter ONLY AFTER updating ALL child templates...');

    // Recreate baseline for comparison after child updates
    r = runCmd('cmd', ['/c', 'reset.bat', 'diff']);
    if (r.status !== 0) { log('ERROR: reset.bat diff failed'); process.exit(1); }

    let okChild = true;
    for (const t of childTemplates) {
      const childBase = path.basename(t);
      const childInstances = findInstancesOfTemplate(childBase);
      log(` - Verifying ${childBase} with ${childInstances.length} instance(s)`);
      for (const f of childInstances) {
        const rel = path.relative(siteRoot, f);
        const baseline = path.join(repoRoot, 'diff', rel);
  if (!exists(baseline)) { log(`   * ${rel}: OK (new file; baseline missing)`); continue; }
        const siteTxt = read(f);
        const baseTxt = read(baseline);
        const onlyMenu = onlyMenuChange(compareText(siteTxt, baseTxt), siteTxt, baseTxt);
        log(`   * ${rel}: ${onlyMenu ? 'OK (only menu change)' : 'DIFF (unexpected changes)'}`);
        if (!onlyMenu) okChild = false;
      }
    }
    if (!okChild) {
      log('Child template verification failed.');
    } else {
      log('Child template verification passed.');
    }
  } else {
    log('No child templates referencing page.dwt found. Skipping Step 5.');
  }

  // Step 6: inject <p>Test</p> into first editable region for all non-templates
  log('Step 6: Injecting <p>Test</p> into first editable region of all non-template html/php files');
  const allPages = listAllFiles(siteRoot, p => /\.(html|php)$/i.test(p) && !p.includes('Templates'));
  let injectedCount = 0;
  for (const f of allPages) {
    try { if (injectParagraphInFirstEditable(f)) injectedCount++; } catch {}
  }
  log(` - Injected into ${injectedCount} file(s)`);

  // Verify only <p>Test</p> differences
  r = runCmd('cmd', ['/c', 'reset.bat', 'diff']);
  if (r.status !== 0) { log('ERROR: reset.bat diff failed'); process.exit(1); }
  let okPara = true;
  const stripPara = s => normalizeLF(s).replace(/\n?<p>Test<\/p>\n?/g, '');
  for (const f of allPages) {
    const rel = path.relative(siteRoot, f);
    const baseline = path.join(repoRoot, 'diff', rel);
    if (!exists(baseline)) { log(` - ${rel}: OK (new file; baseline missing)`); continue; }
    const siteTxt = read(f);
    const baseTxt = read(baseline);
    const equal = stripPara(siteTxt) === stripPara(baseTxt);
    log(` - ${rel}: ${equal ? 'OK (only <p>Test</p> change)' : 'DIFF (unexpected changes)'}`);
    if (!equal) okPara = false;
  }
  if (!okPara) log('Paragraph verification failed.'); else log('Paragraph verification passed.');

  // Step 7: Write log file
  const logPath = nextLogPath();
  write(logPath, logLines.join('\n'));
  log('Log written to:', path.relative(repoRoot, logPath));

  // Step 8: restore site to pre-test
  log('Step 8: Restoring site via reset.bat');
  r = runCmd('cmd', ['/c', 'reset.bat']);
  if (r.status !== 0) { log('ERROR: reset.bat failed'); process.exit(1); }
  
  // Clean up diff folder
  log('Post-test: Cleaning up diff folder');
  cleanupDiffFolder(diffFolderExist, backupDiffName);
  log(diffFolderExist ? ' - Restored original diff folder' : ' - Removed test diff folder');
  
  log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
