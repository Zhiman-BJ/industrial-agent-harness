const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {createAssetPlugins, imageSize} = require('../src/assets/service.cjs');
const {readGodotSprites} = require('../src/assets/godot-text.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'asset-viewer-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  fs.writeFileSync(path.join(root,'image.png'),png);
  const plugins=createAssetPlugins({projectRoot:()=>root});
  async function open(kind,name) {const file=path.join(root,name); return plugins.find(p=>p.id===kind).open({file,artifact:{name,sha256:hash(file)}});}
  return {root,png,plugins,open};
}
test('raster and sprite plugins return bounded image snapshots and explicit clips',async t=>{
  const {root,open}=fixture(t);
  const image=await open('image','image.png'); assert.equal(image.data.images[0].width,1);assert.match(image.data.images[0].url,/^data:image\/png;base64,/);
  fs.writeFileSync(path.join(root,'test.sprite.json'),JSON.stringify({version:1,image:'image.png',columns:1,rows:1,animations:[{name:'idle',fps:8,loop:false,frames:[0]}]}));
  const sprite=await open('sprite','test.sprite.json');assert.equal(sprite.data.initialMode,'sprite');assert.deepEqual(sprite.data.animations[0].frames[0].rect,[0,0,1,1]);assert.equal(sprite.data.animations[0].frames[0].duration,0.125);
  fs.writeFileSync(path.join(root,'image.png'),'changed');assert.equal(image.data.images[0].width,1,'opened snapshot stays immutable');
});
test('asset boundary rejects traversal, symlink escape, oversized images and bad frame metadata',async t=>{
  const {root,png,plugins,open}=fixture(t); const outside=fs.mkdtempSync(path.join(os.tmpdir(),'asset-outside-'));t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'image.png'),png);fs.symlinkSync(path.join(outside,'image.png'),path.join(root,'escape.png'));
  await assert.rejects(open('image','escape.png'),/outside/);
  const descriptor={version:1,image:'image.png',columns:1,rows:1,animations:[{name:'idle',fps:8,frames:[1]}]};
  fs.writeFileSync(path.join(root,'test.sprite.json'),JSON.stringify(descriptor));await assert.rejects(open('sprite','test.sprite.json'),/index/);
  descriptor.image=path.join(outside,'image.png');fs.writeFileSync(path.join(root,'test.sprite.json'),JSON.stringify(descriptor));await assert.rejects(open('sprite','test.sprite.json'),/relative/);
  descriptor.image='../'+path.basename(outside)+'/image.png';fs.writeFileSync(path.join(root,'test.sprite.json'),JSON.stringify(descriptor));await assert.rejects(open('sprite','test.sprite.json'),/outside/);
  const large=Buffer.from(png);large.writeUInt32BE(9000,16);fs.writeFileSync(path.join(root,'large.png'),large);await assert.rejects(open('image','large.png'),/dimensions/);
  const file=path.join(root,'image.png');await assert.rejects(plugins[0].open({file,artifact:{sha256:'bad'}}),/changed/);
  assert.throws(()=>imageSize(Buffer.from('<svg onload="evil"/>')),/Unsupported/);
});
const player = `[gd_scene format=3]\n[ext_resource type="Texture2D" path="res://image.png" id="img"]\n[sub_resource type="Animation" id="run"]\nlength = 1\nloop_mode = 1\ntracks/0/type = "value"\ntracks/0/path = NodePath("Sprite2D:frame")\ntracks/0/keys = {"times": PackedFloat32Array(0, 0.25), "update": 1, "values": [0, 0]}\n[sub_resource type="AnimationLibrary" id="lib"]\n_data = {&"run": SubResource("run")}\n[node name="Sprite2D" type="Sprite2D" parent="."]\ntexture = ExtResource("img")\nhframes = 1\nvframes = 1\n`;
test('Godot AnimationPlayer reads action names and variable frame timing without scripts',async t=>{
  const {root,open,plugins}=fixture(t);fs.writeFileSync(path.join(root,'player.tscn'),player);
  assert.equal(plugins.find(p=>p.id==='animation').matches(path.join(root,'player.tscn')),true);
  const data=(await open('animation','player.tscn')).data;assert.equal(data.animations[0].name,'run');assert.deepEqual(data.animations[0].frames.map(f=>f.duration),[0.25,0.75]);
  assert.throws(()=>readGodotSprites(player.replace('"update": 1','"update": 0')),/discrete/);
  assert.throws(()=>readGodotSprites(player.replace('"values": [0, 0]','"values": [execute("anything"), 0]')),/Unsupported/);
});
test('SpriteFrames accepts AtlasTexture regions and weighted durations',async t=>{
  const {root,open}=fixture(t);const source=`[gd_resource type="SpriteFrames" format=3]\n[ext_resource type="Texture2D" path="res://image.png" id="img"]\n[sub_resource type="AtlasTexture" id="tile"]\natlas = ExtResource("img")\nregion = Rect2(0, 0, 1, 1)\n[resource]\nanimations = [{"name": &"idle", "speed": 5.0, "loop": true, "frames": [{"duration": 2.0, "texture": SubResource("tile")}]}]\n`;
  fs.writeFileSync(path.join(root,'idle.tres'),source);const data=(await open('animation','idle.tres')).data;assert.equal(data.animations[0].frames[0].duration,0.4);assert.deepEqual(data.animations[0].frames[0].rect,[0,0,1,1]);
  fs.writeFileSync(path.join(root,'idle.tres'),source.replace('Rect2(0, 0, 1, 1)','Rect2(1, 0, 1, 1)'));await assert.rejects(open('animation','idle.tres'),/region/);
});
test('animation timeline honors weighted durations, non-looping endings and grid order',async()=>{
  const {frameAtTime,gridFrames}=await import('../src/assets/model.ts');const frames=gridFrames(0,128,64,2,1,4);frames[1].duration=0.75;
  assert.deepEqual(frames[1].rect,[64,0,64,64]);assert.equal(frameAtTime(frames,0.2,true).index,0);assert.equal(frameAtTime(frames,0.5,true).index,1);assert.equal(frameAtTime(frames,1.1,true).index,0);assert.deepEqual(frameAtTime(frames,1.1,false),{index:1,ended:true});
});
