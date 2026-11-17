// Run during the call (after hook-pc.js): 6 one-second samples of the inbound audio.
// ~70 bytes/s with totalAudioEnergy 0 = comfort silence (the far side sends nothing).
const out = [];
for (let i = 0; i < 6; i++) {
  for (const [k, p] of window.__pcs.entries()) {
    if (p.connectionState === 'closed') continue;
    (await p.getStats()).forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.push({ t: i, pc: k, state: p.connectionState, level: r.audioLevel, energy: +(r.totalAudioEnergy || 0).toFixed(4), bytes: r.bytesReceived });
    });
  }
  await new Promise(r => setTimeout(r, 1000));
}
JSON.stringify(out);
