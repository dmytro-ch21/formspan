/**
 * N84 — `listDays`, the mobile client's first caller of `GET /v1/nutrition/days`.
 * Mirrors `apps/web/src/lib/nutritionApi.ts`'s `listDays`.
 */

import { listDays } from '../nutritionApi';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = async () => 'token';

beforeEach(() => mockApi.mockReset());

describe('listDays', () => {
  it('requests the range as query params', async () => {
    mockApi.mockResolvedValue({ days: [] });
    await listDays(getToken, { from: '2026-07-01', to: '2026-08-01' });
    expect(mockApi).toHaveBeenCalledWith(getToken, '/nutrition/days?from=2026-07-01&to=2026-08-01');
  });

  it('normalises a missing days field to an empty array', async () => {
    mockApi.mockResolvedValue({});
    const r = await listDays(getToken, { from: '2026-07-01', to: '2026-08-01' });
    expect(r).toEqual([]);
  });

  it('resolves to the days on success', async () => {
    const day = { eaten_on: '2026-08-01', kcal: 2200, protein_g: 150, carb_g: 200, fat_g: 70, fibre_g: 25, saturated_fat_g: null, sugar_g: null, added_sugar_g: null, sodium_mg: null, cholesterol_mg: null, entries: 3, target_kcal: 2400, target_protein_g: 160 };
    mockApi.mockResolvedValue({ days: [day] });
    const r = await listDays(getToken, { from: '2026-08-01', to: '2026-08-01' });
    expect(r).toEqual([day]);
  });
});
