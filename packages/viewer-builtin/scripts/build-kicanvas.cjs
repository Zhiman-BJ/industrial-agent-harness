// Rebuild from an unmodified checkout of the pinned upstream commit with esbuild installed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const {execFileSync} = require('node:child_process');
const revision = 'b031159eb74aaa7eef2b026fd85d35bc05ff2095';
async function build() {
  const source = fs.realpathSync(process.argv[2]);
  if (execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim() !== revision) throw Error('Use the pinned KiCanvas revision.');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: source, encoding: 'utf8'}).trim()) throw Error('Use an unmodified upstream checkout.');
  const esbuild = createRequire(path.join(source, 'package.json'))('esbuild');
  if (esbuild.version !== '0.27.1') throw Error('Build with esbuild 0.27.1.');
  const target = path.resolve(__dirname, '../src/kicad/vendor');
  fs.mkdirSync(target, {recursive: true});
  await esbuild.build({
    stdin: {contents: 'import "./kicanvas/elements/kicanvas-embed"; import "./kicanvas/elements/kc-board/app"; import "./kicanvas/elements/kc-schematic/app"; import {KCUIIconElement} from "./kc-ui/icon"; import {sprites_url} from "./kicanvas/icons/sprites"; KCUIIconElement.sprites_url = sprites_url;', resolveDir: path.join(source, 'src'), sourcefile: 'harness-embed.ts'},
    outfile: path.join(target, 'kicanvas.js'), bundle: true, format: 'esm', target: 'es2022',
    minify: true, keepNames: true, define: {DEBUG: 'false'},
    loader: {'.js': 'ts', '.glsl': 'text', '.css': 'text', '.svg': 'text', '.kicad_wks': 'text'},
    tsconfig: path.join(source, 'tsconfig.json'),
    plugins: [{name: 'offline-embed', setup(build) {
      build.onLoad({filter: /kicanvas-embed\.ts$/}, args => ({
        // Upstream appends Google Fonts. Harness supplies a local icon font and system UI fonts.
        contents: fs.readFileSync(args.path, 'utf8').split('/* Import required fonts.')[0], loader: 'ts',
      }));
      build.onLoad({filter: /\.css$/}, async args => ({contents: (await esbuild.transform(fs.readFileSync(args.path, 'utf8'), {loader: 'css', minify: true})).code, loader: 'text'}));
    }}],
  });
  fs.copyFileSync(path.join(source, 'LICENSE.md'), path.join(target, 'LICENSE.md'));
  fs.copyFileSync(path.join(source, 'third_party/earcut/LICENSE'), path.join(target, 'earcut-LICENSE'));
  fs.copyFileSync(path.join(source, 'third_party/newstroke/THIRD_PARTY_README.md'), path.join(target, 'newstroke-README.md'));
  const glyphs = fs.readFileSync(path.join(source, 'src/kicad/text/newstroke-glyphs.ts'), 'utf8');
  fs.writeFileSync(path.join(target, 'newstroke-NOTICES.txt'), glyphs.slice(0, glyphs.indexOf('export ')).trimEnd() + '\n');
  const manifest = {repository: 'https://github.com/theacodes/kicanvas', revision, esbuild: esbuild.version, files: {}};
  for (const name of ['kicanvas.js', 'symbols.ttf']) manifest.files[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(target, name))).digest('hex');
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
build().catch(error => {console.error(error); process.exitCode = 1;});
