import * as Tone from 'tone';
import type { Note } from './types';

// Both sources use the same AudioContext clock and precisely clipped [start, end).
// Scheduling each loop ahead on that clock avoids HTMLMediaElement/timeupdate drift.
export class Audition {
  private synth?: Tone.PolySynth;
  private original?: Tone.Player;
  private buffer?: Tone.ToneAudioBuffer;
  private meter?: Tone.Meter;
  private loadedUrl = '';
  private generation = 0;
  private timer = 0;
  private frame = 0;
  private playing = false;

  stop() {
    ++this.generation;
    this.playing = false;
    window.clearInterval(this.timer);
    cancelAnimationFrame(this.frame);
    // Disposing also cancels future notes already scheduled in the lookahead window.
    this.synth?.dispose(); this.synth = undefined;
    this.original?.dispose(); this.original = undefined;
    this.meter?.dispose(); this.meter = undefined;
  }

  async play(args: { notes: Note[]; start: number; end: number; loop: boolean; mode: 'original' | 'melody'; audioUrl: string; onTime: (time: number) => void; onLevel: (db: number) => void; onStop: () => void }) {
    this.stop();
    const token = this.generation;
    await Tone.start(); // Always initiated by a user click.
    if (token !== this.generation) return;
    if (args.mode === 'original') {
      if (this.loadedUrl !== args.audioUrl) {
        const buffer = await Tone.ToneAudioBuffer.fromUrl(args.audioUrl);
        if (token !== this.generation) { buffer.dispose(); return; }
        this.buffer?.dispose(); this.buffer = buffer;
        this.loadedUrl = args.audioUrl;
      }
      this.original = new Tone.Player(this.buffer!).toDestination();
    } else {
      this.synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.005, decay: 0.08, sustain: 0.65, release: 0.015 },
        volume: -12,
      }).toDestination();
    }
    if (token !== this.generation) return;
    this.meter = new Tone.Meter({ smoothing: 0.3 });
    (this.original || this.synth)!.connect(this.meter);
    const length = args.end - args.start;
    if (length < 0.025) throw new Error('试听区间过短');
    const origin = Tone.now() + 0.06;
    let nextCycle = origin;
    let scheduledOnce = false;
    this.playing = true;
    const scheduleCycle = (at: number) => {
      if (args.mode === 'original') {
        this.original!.start(at, args.start, length);
      } else {
        for (const n of args.notes) {
          const start = Math.max(n.start, args.start), end = Math.min(n.end, args.end);
          if (end > start) this.synth!.triggerAttackRelease(Tone.Frequency(n.pitch, 'midi').toFrequency(), end - start,
            at + start - args.start, n.velocity / 127);
        }
      }
    };
    const pump = () => {
      while ((!scheduledOnce || args.loop) && nextCycle < Tone.now() + 0.25) {
        scheduleCycle(nextCycle); scheduledOnce = true; nextCycle += length;
      }
    };
    pump(); this.timer = window.setInterval(pump, 30);
    let lastUiUpdate = -1;
    const tick = () => {
      if (!this.playing) return;
      const elapsed = Math.max(0, Tone.immediate() - origin);
      if (!args.loop && elapsed >= length) {
        this.stop(); args.onTime(args.end); args.onLevel(-90); args.onStop(); return;
      }
      if (elapsed - lastUiUpdate > 1 / 30) {
        args.onTime(args.start + (elapsed % length));
        args.onLevel(Math.max(-90, Number(this.meter!.getValue())));
        lastUiUpdate = elapsed;
      }
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  dispose() { this.stop(); this.buffer?.dispose(); this.buffer = undefined; this.loadedUrl = ''; }
}
