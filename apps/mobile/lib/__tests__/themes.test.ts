/**
 * N82 — the write half of `lib/themes.ts`: `setTheme`, `deleteTheme`, and the
 * pure `cleanThemeTitle` decision the component layer cannot exercise
 * directly (see `theme.go`'s `CleanTitle`, which this mirrors and which
 * carries the identical comment about why it had to be pulled out).
 *
 * Mirrors `curriculumWrite.test.ts`'s shape (mock `apiRequest`, assert the
 * exact call) because that is what a thin wire wrapper needs pinned — the
 * METHOD, the PATH (URL-encoded), and that the body is exactly what
 * `setTheme`'s caller asked for, JSON-encoded and nothing else.
 */

import { cleanThemeTitle, deleteTheme, fetchThemes, MAX_THEME_TITLE, setTheme } from '../themes';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = async () => 'token';

beforeEach(() => mockApi.mockReset());

describe('cleanThemeTitle', () => {
  // Table-driven, matching `theme.go`'s own `CleanTitle` cases as closely as
  // a client-side trim (no rune-count refusal here — see MAX_THEME_TITLE's
  // doc comment for why the length limit is the TextInput's job, not this
  // function's) can.
  it.each([
    ['  Deload week  ', 'Deload week'],
    ['Guard retention', 'Guard retention'],
    ['   ', ''],
    ['', ''],
    ['\n\tChase the squat\n', 'Chase the squat'],
  ])('trims %j to %j', (input, expected) => {
    expect(cleanThemeTitle(input)).toBe(expected);
  });
});

describe('MAX_THEME_TITLE', () => {
  it('mirrors the backend module (theme.go MaxTitle)', () => {
    expect(MAX_THEME_TITLE).toBe(80);
  });
});

describe('fetchThemes', () => {
  it('GETs /themes with the from/to range as query params', async () => {
    mockApi.mockResolvedValue({ themes: [] });
    await fetchThemes(getToken, { from: '2026-08-03', to: '2026-08-09' });
    expect(mockApi).toHaveBeenCalledWith(
      getToken,
      '/themes?from=2026-08-03&to=2026-08-09',
    );
  });

  it('degrades a missing `themes` field to an empty array rather than undefined', async () => {
    mockApi.mockResolvedValue({});
    expect(await fetchThemes(getToken, { from: '2026-08-03', to: '2026-08-09' })).toEqual([]);
  });
});

describe('setTheme', () => {
  it('PUTs to the specific week, URL-encoding the date, with the title as the body', async () => {
    mockApi.mockResolvedValue({ week_start: '2026-08-03', title: 'Deload', notes: '' });
    await setTheme(getToken, '2026-08-03', { title: 'Deload' });
    expect(mockApi).toHaveBeenCalledWith(getToken, '/themes/2026-08-03', {
      method: 'PUT',
      body: JSON.stringify({ title: 'Deload', notes: '' }),
    });
  });

  it('defaults notes to an empty string when the caller omits it', async () => {
    mockApi.mockResolvedValue({ week_start: '2026-08-03', title: 'Deload', notes: '' });
    await setTheme(getToken, '2026-08-03', { title: 'Deload' });
    const [, , init] = mockApi.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.notes).toBe('');
  });

  it('returns the saved theme', async () => {
    const saved = { week_start: '2026-08-03', title: 'Deload', notes: '' };
    mockApi.mockResolvedValue(saved);
    expect(await setTheme(getToken, '2026-08-03', { title: 'Deload' })).toEqual(saved);
  });
});

describe('deleteTheme', () => {
  it('DELETEs the specific week, with no body', async () => {
    mockApi.mockResolvedValue(undefined);
    await deleteTheme(getToken, '2026-08-03');
    expect(mockApi).toHaveBeenCalledWith(getToken, '/themes/2026-08-03', { method: 'DELETE' });
  });
});
