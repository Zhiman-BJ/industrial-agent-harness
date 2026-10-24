#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createStagedDemo } = require('../packages/harness-recording/src/index.cjs');
const [input, output] = process.argv.slice(2);
if (!input || !output || process.argv.length !== 4) {
  console.error('Usage: node scripts/build-staged-demo.cjs STAGES_JSON NEW_BUNDLE_DIRECTORY');
  process.exitCode = 64;
} else {
  try {
    const source = path.resolve(input);
    const specification = JSON.parse(fs.readFileSync(source, 'utf8'));
    const stages = Array.isArray(specification) ? specification : specification.stages;
    const bundle = createStagedDemo({
      directory: path.resolve(output),
      title: specification.title,
      prompt: specification.prompt,
      recordingId: specification.recordingId,
      stages: stages.map(stage => ({
        ...stage,
        imagePath: path.resolve(path.dirname(source), stage.imagePath),
      })),
    });
    console.log(
      JSON.stringify(
        {
          directory: path.resolve(output),
          constructed: true,
          stages: bundle.manifest.replayStages.length,
          events: bundle.events.length,
          images: bundle.manifest.assets.map(asset => ({ id: asset.id, sha256: asset.sha256 })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
