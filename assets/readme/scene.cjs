// README banner for cc2codex, built with the Readme-Banner skill:
//   node <readme-banner>/scripts/build.cjs assets/readme/scene.cjs --out assets/readme/output/hero-v1
// Left: name and promise. Right: Claude Code and Codex hand a session to each other through one local handoff document.
const path = require('node:path');

module.exports = ({ draw: d, sceneDir }) => {
  const icon = (name) => path.join(sceneDir, 'icons', name);
  const rows = [
    { text: 'Your requests', fill: '#F4D786' },
    { text: 'Tasks & plan', fill: '#C9DFC9' },
    { text: 'Changed files', fill: '#CDDDF1' },
    { text: 'Last steps', fill: '#E8D5E8' },
  ];
  const card = { x: 1005, y: 150, w: 250, h: 300 };

  const diagram = d.group({
    art:
      // the two agents
      d.tile({ cx: 735, cy: 300, size: 150, fill: '#F6DFD2', rotate: -3, seed: 2, file: icon('claude-code.svg') })
      + d.tile({ cx: 1525, cy: 300, size: 150, fill: '#DFEAFA', rotate: 3, seed: 5, file: icon('codex.svg') })
      // the handoff document in the middle
      + d.box({ x: card.x + 11, y: card.y + 11, w: card.w, h: card.h, fill: '#E7ECDD', rotate: 3, seed: 3 })
      + d.box({ x: card.x, y: card.y, w: card.w, h: card.h, fill: '#FFFDF7', rotate: 1, seed: 4 })
      + d.path(`M${card.x + 4} ${card.y + 48} Q${card.x + 125} ${card.y + 50} ${card.x + card.w - 4} ${card.y + 49}`, { color: '#9C9C8D', width: 1.8 })
      + `<circle cx="${card.x + 22}" cy="${card.y + 24}" r="4" fill="#D89A83"/><circle cx="${card.x + 36}" cy="${card.y + 24}" r="4" fill="#E4C469"/><circle cx="${card.x + 50}" cy="${card.y + 24}" r="4" fill="#9EB59C"/>`
      + rows.map((r, i) => `<rect x="${card.x + 22}" y="${card.y + 82 + i * 54}" width="24" height="24" rx="7" fill="${r.fill}"/>`).join('')
      + d.path(`M${card.x + 232} ${card.y - 22} l9 -14 M${card.x + 254} ${card.y - 8} l16 -5 M${card.x + 212} ${card.y - 28} l-1 -16`, { color: '#BD9744', width: 2.7 })
      // top lane, rightwards: Claude Code -> doc -> Codex
      + d.arrow({ from: [835, 262], to: [982, 262], width: 3.2, head: 15 })
      + d.arrow({ from: [1296, 262], to: [1425, 262], width: 3.2, head: 15 })
      // bottom lane, leftwards: Codex -> doc -> Claude Code
      + d.arrow({ from: [1425, 346], to: [1296, 346], width: 3.2, head: 15 })
      + d.arrow({ from: [982, 346], to: [835, 346], width: 3.2, head: 15 }),
    labels: [
      { text: 'Claude Code', x: 625, y: 392, w: 220, h: 42, size: 27, letteringStyle: 'upright', align: 'center', rotate: -1.5 },
      { text: 'Codex', x: 1415, y: 392, w: 220, h: 42, size: 27, letteringStyle: 'upright', align: 'center', rotate: 1.5 },
      { text: 'cc2codex', x: 840, y: 212, w: 140, h: 38, size: 25, bold: true, letteringStyle: 'upright', align: 'center' },
      { text: 'codex2cc', x: 1291, y: 358, w: 140, h: 38, size: 25, bold: true, letteringStyle: 'upright', align: 'center' },
      { text: 'HANDOFF.md', x: card.x + 66, y: card.y + 7, w: 170, h: 34, size: 22, letteringStyle: 'body', color: '#6E7065', rotate: 1 },
      ...rows.map((r, i) => ({ text: r.text, x: card.x + 58, y: card.y + 73 + i * 54, w: 185, h: 42, size: 25, letteringStyle: 'body', rotate: 1 })),
      { text: 'Picks up where it stopped', x: 960, y: 478, w: 340, h: 44, size: 27, letteringStyle: 'body', align: 'center' },
    ],
  }, { scale: 0.93, origin: [1610, 320] });

  return {
    id: 'hero',
    title: 'cc2codex - hand off a half-finished coding session between Claude Code and Codex',
    description: 'Claude Code and Codex hand a session to each other: cc2codex turns a Claude Code session into a local HANDOFF.md that Codex reads, and codex2cc does the reverse. The document carries your requests, tasks and plan, changed files, and the last steps.',
    width: 1680,
    height: 640,
    background: d.paper(),
    art:
      d.path('M62 301 Q250 312 512 298', { color: '#F4D786', width: 17, opacity: 0.7 })
      + d.path('M587 146 Q583 309 588 484', { color: '#C9C5B6', width: 1.4, opacity: 0.65 })
      + diagram.art,
    labels: [
      { text: 'Agent handoff', x: 66, y: 171, w: 440, h: 36, size: 23, letteringStyle: 'upright', color: '#6E7065' },
      { text: 'cc2codex', x: 60, y: 192, w: 505, h: 148, size: 100, bold: true, letteringStyle: 'upright', letterSpacing: -3 },
      { text: 'Out of quota? Keep going.', x: 66, y: 335, w: 495, h: 57, size: 32, letteringStyle: 'upright' },
      { text: 'One local handoff doc. No model calls.', x: 68, y: 408, w: 490, h: 42, size: 21, letteringStyle: 'upright', color: '#6E7065' },
      ...diagram.labels,
    ],
    sources: [
      'Claude Code and Codex marks: LobeHub Icons (https://github.com/lobehub/lobe-icons), MIT license, notice in assets/readme/icons/LobeHub-LICENSE.txt. The SVG geometry was taken from the copy embedded in the fly-brief README banner by the same author. Marks remain their respective owners\' marks.',
      'Paper, boxes, document card, arrows, and lettering are original SVG geometry from the Readme-Banner skill helpers; lettering uses bundled Comic Relief and Kalam outlines (SIL OFL).',
      'Claims (offline, no model calls, both directions, document contents) are taken from this repository\'s implementation in src/.',
    ],
  };
};
