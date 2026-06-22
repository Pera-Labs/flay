const { withAppDelegate, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const FILES = ['FlayDeck.h', 'FlayDeck.m', 'FlayBridge.h', 'FlayBridge.m'];
const HEADER_IMPORT = '#import "FlayDeck.h"';
const SWIFT_CALL = 'FlayDeck.install()';
const OBJC_CALL = '[FlayDeck install];';

function withFlaySources(config) {
  return withXcodeProject(config, async (cfg) => {
    const proj = cfg.modResults;
    const projName = cfg.modRequest.projectName;
    const groupKey = proj.findPBXGroupKey({ name: projName }) || proj.findPBXGroupKey({ name: 'Application' });
    if (!groupKey) return cfg;
    for (const f of FILES) {
      const filePath = `${projName}/${f}`;
      if (proj.hasFile(filePath)) continue;
      if (f.endsWith('.m')) {
        proj.addSourceFile(filePath, { target: proj.getFirstTarget().uuid }, groupKey);
      } else {
        proj.addHeaderFile(filePath, { target: proj.getFirstTarget().uuid }, groupKey);
      }
    }
    return cfg;
  });
}

function injectSwift(contents) {
  if (contents.includes(SWIFT_CALL)) return contents;
  return contents.replace(/(didFinishLaunchingWithOptions[^\{]*\{)/, `$1\n    ${SWIFT_CALL}`);
}

function injectObjC(contents) {
  if (contents.includes(OBJC_CALL)) return contents;
  let out = contents;
  if (!out.includes(HEADER_IMPORT)) out = HEADER_IMPORT + '\n' + out;
  out = out.replace(/(didFinishLaunchingWithOptions[^\{]*\{)/, `$1\n  ${OBJC_CALL}`);
  return out;
}

function withBridgingHeader(config) {
  return withDangerousMod(config, ['ios', async (cfg) => {
    const iosDir = cfg.modRequest.platformProjectRoot;
    try {
      const projDir = fs.readdirSync(iosDir).find((d) => {
        const p = path.join(iosDir, d);
        return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => f.endsWith('-Bridging-Header.h'));
      });
      if (!projDir) return cfg;
      const bridge = fs.readdirSync(path.join(iosDir, projDir)).find((f) => f.endsWith('-Bridging-Header.h'));
      if (!bridge) return cfg;
      const bridgePath = path.join(iosDir, projDir, bridge);
      let txt = fs.readFileSync(bridgePath, 'utf8');
      if (!txt.includes('FlayDeck.h')) {
        txt = txt.trimEnd() + '\n' + HEADER_IMPORT + '\n';
        fs.writeFileSync(bridgePath, txt);
      }
    } catch (e) {
      console.warn('[withFlay] bridging header inject failed:', e.message);
    }
    return cfg;
  }]);
}

function copyNativeSources(config) {
  return withDangerousMod(config, ['ios', async (cfg) => {
    const iosDir = cfg.modRequest.platformProjectRoot;
    const srcDir = path.join(cfg.modRequest.projectRoot, 'node_modules', 'flay', 'ios');
    try {
      const projName = fs.readdirSync(iosDir).find((d) => d.endsWith('.xcodeproj'))?.replace('.xcodeproj', '');
      if (!projName) return cfg;
      const targetDir = path.join(iosDir, projName);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      for (const f of FILES) {
        const from = path.join(srcDir, f);
        const to = path.join(targetDir, f);
        if (fs.existsSync(from)) fs.copyFileSync(from, to);
      }
    } catch (e) {
      console.warn('[withFlay] copy failed:', e.message);
    }
    return cfg;
  }]);
}

module.exports = function withFlay(config) {
  config = copyNativeSources(config);
  config = withFlaySources(config);
  config = withBridgingHeader(config);
  config = withAppDelegate(config, (cfg) => {
    const lang = cfg.modResults.language;
    if (lang === 'swift') cfg.modResults.contents = injectSwift(cfg.modResults.contents);
    else cfg.modResults.contents = injectObjC(cfg.modResults.contents);
    return cfg;
  });
  return config;
};
