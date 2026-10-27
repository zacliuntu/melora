import { test, expect, type Page } from '@playwright/test';

test.describe.serial('real Basic Pitch → edit → audition → human confirmation', () => {
  let id: string;
  const errors: string[] = [];
  test.beforeEach(async ({ page }) => { page.on('pageerror', e => errors.push(e.message)); });
  const saved = async (page: Page) => { await expect(page.getByTestId('save-state')).toContainText('已保存'); };
  const drag = async (page: Page, x: number, y: number, dx: number, dy: number) => {
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 8 }); await page.mouse.up();
  };

  test('upload real audio, edit pitch/timing, resize, add, marquee, undo/redo, autosave and history', async ({ page, request }) => {
    await page.goto('/');
    await page.getByTestId('audio-upload').setInputFiles('/tmp/melody-test-phrase.wav');
    await expect(page.getByTestId('piano-grid')).toBeVisible({ timeout: 210_000 });
    id = new URL(page.url()).searchParams.get('project')!;
    const initial = await (await request.get(`/api/projects/${id}`)).json();
    expect(initial.transcription_engine).toContain('Basic Pitch');
    expect(initial.notes.length).toBeGreaterThanOrEqual(3);
    expect(initial.waveform.length).toBeGreaterThan(100);
    expect(initial.duration).toBeCloseTo(4);
    // Keep actual inference output as v1; use a known reviewed score as v2 to make
    // drag geometry independent of small model/runtime numerical differences.
    const baseline = [
      { id: 'c4', pitch: 60, start: 0.25, end: 0.85, velocity: 100 },
      { id: 'e4', pitch: 64, start: 1.05, end: 1.65, velocity: 100 },
      { id: 'g4', pitch: 67, start: 1.85, end: 2.45, velocity: 100 },
      { id: 'a4', pitch: 69, start: 2.65, end: 3.35, velocity: 100 },
    ];
    expect((await request.put(`/api/projects/${id}/notes`, { data: { notes: baseline, bpm: 120, expected_revision: initial.revision } })).ok()).toBeTruthy();
    await page.reload();
    const n = page.locator('[data-note-id="e4"]');
    await expect(n).toBeVisible();
    let b = (await n.boundingBox())!;
    await drag(page, b.x + b.width / 2, b.y + b.height / 2, 18, -40);
    await expect(n).toHaveAttribute('data-pitch', '66');
    await expect(n).toHaveAttribute('data-start', '1.250000');
    await expect(n).toHaveAttribute('data-end', '1.850000');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(n).toHaveAttribute('data-pitch', '64');
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(n).toHaveAttribute('data-pitch', '66');
    b = (await n.boundingBox())!;
    await drag(page, b.x + b.width - 3, b.y + 8, 18, 0);
    await expect(n).toHaveAttribute('data-end', '2.050000');
    b = (await n.boundingBox())!;
    await drag(page, b.x + 2, b.y + 8, 9, 0);
    await expect(n).toHaveAttribute('data-start', '1.350000');
    await saved(page);
    // Add through the visible grid using the actual double-click UI.
    const grid = (await page.getByTestId('piano-grid').boundingBox())!;
    const x = grid.x + 3.55 * 90, y = grid.y + (127 - 63) * 20 + 10;
    await page.mouse.dblclick(x, y);
    await expect(page.getByTestId('note')).toHaveCount(5);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByTestId('note')).toHaveCount(4);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByTestId('note')).toHaveCount(5);
    // Empty-space marquee selects two notes, and a drag moves both together.
    const g = page.locator('[data-note-id="g4"]'), a = page.locator('[data-note-id="a4"]');
    const gb = (await g.boundingBox())!, ab = (await a.boundingBox())!;
    await drag(page, gb.x - 5, ab.y - 8, ab.x + ab.width - gb.x + 10, gb.y + gb.height - ab.y + 7);
    await expect(page.locator('.note.selected')).toHaveCount(2);
    await drag(page, gb.x + 20, gb.y + 8, 9, -20);
    await expect(g).toHaveAttribute('data-pitch', '68');
    await expect(a).toHaveAttribute('data-pitch', '70');
    await saved(page);
    const persisted = await (await request.get(`/api/projects/${id}`)).json();
    expect(persisted.notes.find((v: any) => v.id === 'e4').start).toBeCloseTo(1.35);
    // Server persistence across a fresh page and a restorable initial inference.
    await page.reload(); await expect(n).toHaveAttribute('data-pitch', '66');
    await page.getByRole('button', { name: '版本历史', exact: true }).click();
    const rows = page.locator('.version');
    await expect(rows.last()).toContainText('Basic Pitch 初始识别');
    await rows.last().getByRole('button', { name: '恢复', exact: true }).click();
    await expect(page.getByTestId('note')).toHaveCount(initial.notes.length);
    await page.screenshot({ path: 'test-results/editor.png', fullPage: true });
  });

  test('time-range audition stops at its end, loops, and A/B shares the same interval', async ({ page }) => {
    await page.goto(`/?project=${id}`);
    const ruler = page.getByTestId('time-ruler');
    await expect(ruler).toBeVisible();
    const b = (await ruler.boundingBox())!;
    await drag(page, b.x + 90, b.y + 12, 90, 0);
    await expect(page.getByTestId('region-label')).toHaveText('1.00 – 2.00 s');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect(page.getByTestId('playback-status')).toHaveText('播放中');
    await expect.poll(() => page.getByTestId('output-level').evaluate(el => (el as HTMLMeterElement).value)).toBeGreaterThan(-65);
    await expect(page.getByTestId('playback-status')).toHaveText('已停止');
    await expect(page.getByTestId('playhead')).toContainText('2.00');
    await page.getByTestId('loop').click();
    await page.getByRole('button', { name: '播放', exact: true }).click();
    // Observe >2 complete cycles; cursor must always stay inside the selected region.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(310);
      const cursor = parseFloat((await page.getByTestId('playhead').textContent())!);
      expect(cursor).toBeGreaterThanOrEqual(1); expect(cursor).toBeLessThanOrEqual(2);
    }
    await expect(page.getByTestId('playback-status')).toHaveText('循环播放中');
    await page.getByRole('button', { name: 'A 原始哼唱', exact: true }).click();
    await expect.poll(() => page.getByTestId('output-level').evaluate(el => (el as HTMLMeterElement).value)).toBeGreaterThan(-65);
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('playback-status')).toHaveText('循环播放中');
    await expect(page.getByTestId('region-label')).toHaveText('1.00 – 2.00 s');
    await page.getByRole('button', { name: 'B 修正旋律', exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect(page.getByTestId('playback-status')).toHaveText('已停止');
    await page.screenshot({ path: 'test-results/interval-playback.png', fullPage: true });
  });

  test('explicit human confirmation produces immutable artifacts and closes every edit route', async ({ page, request }) => {
    await page.goto(`/?project=${id}`);
    expect((await request.post(`/api/projects/${id}/arrange`)).status()).toBe(409);
    expect((await request.get(`/api/projects/${id}/exports/master_melody.mid`)).status()).toBe(409);
    await page.getByRole('button', { name: '确认主旋律并锁定 →', exact: true }).click();
    const confirm = page.getByRole('button', { name: '确认并生成只读文件', exact: true });
    await expect(confirm).toBeDisabled();
    await page.getByRole('checkbox', { name: '我已对照原始哼唱试听并确认当前主旋律。' }).check();
    await confirm.click();
    await expect(page.getByText('主旋律已确认并锁定', { exact: true })).toBeVisible();
    const p = await (await request.get(`/api/projects/${id}`)).json();
    expect(p.status).toBe('approved');
    expect(p.master.human_confirmed).toBe(true);
    for (const [route, method, data] of [
      ['notes', 'put', { notes: p.notes, bpm: p.bpm, expected_revision: p.revision }],
      ['restore', 'post', { version: 1, expected_revision: p.revision }],
      ['transcribe', 'post', {}],
    ] as const) {
      const result = method === 'put' ? await request.put(`/api/projects/${id}/${route}`, { data }) : await request.post(`/api/projects/${id}/${route}`, { data });
      expect(result.status()).toBe(423);
    }
    expect((await request.post(`/api/projects/${id}/arrange`)).status()).toBe(501);
    const midi = await request.get(`/api/projects/${id}/exports/master_melody.mid`);
    expect((await midi.body()).subarray(0, 4).toString()).toBe('MThd');
    const xml = await request.get(`/api/projects/${id}/exports/master_melody.musicxml`);
    expect(await xml.text()).toContain('score-partwise');
    const etag = midi.headers().etag;
    expect((await request.post(`/api/projects/${id}/confirm`, { data: { human_confirmed: true, expected_revision: p.revision } })).ok()).toBeTruthy();
    expect((await request.get(`/api/projects/${id}/exports/master_melody.mid`)).headers().etag).toBe(etag);
    await page.reload();
    await expect(page.getByRole('button', { name: '＋ 画音符', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await page.screenshot({ path: 'test-results/confirmed.png', fullPage: true });
    expect(errors).toEqual([]);
  });
});
