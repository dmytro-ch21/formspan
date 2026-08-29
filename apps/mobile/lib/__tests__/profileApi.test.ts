/**
 * N12 — the avatar client. Multipart, going through `apiRequest` (never
 * this file's own `request`, which always sets `Content-Type:
 * application/json` and would corrupt a multipart body's boundary).
 */

import { uploadAvatar, removeAvatar } from '../profile';
import { DEFAULT_TIMEOUT_MS, SLOW_REQUEST_TIMEOUT_MS } from '../authedFetch';

const mockApi = jest.fn();
jest.mock('../apiRequest', () => ({ apiRequest: (...a: unknown[]) => mockApi(...a) }));

const getToken = async () => 'token';

beforeEach(() => mockApi.mockReset());

describe('uploadAvatar', () => {
  it('sends a multipart POST to /profile/avatar', async () => {
    mockApi.mockResolvedValue({ user_id: 'u1', avatar_url: 'https://cdn.test/a.jpg' });
    await uploadAvatar(getToken, { uri: 'file:///photo.jpg', mimeType: 'image/jpeg' });

    expect(mockApi).toHaveBeenCalledWith(
      getToken,
      '/profile/avatar',
      expect.objectContaining({ method: 'POST', body: expect.any(FormData) }),
      expect.anything(),
    );
  });

  it('names the multipart part "avatar", matching the backend contract', async () => {
    mockApi.mockResolvedValue({});
    await uploadAvatar(getToken, { uri: 'file:///photo.jpg', mimeType: 'image/jpeg' });

    const body = mockApi.mock.calls[0][2].body as FormData;
    expect([...body.keys()]).toContain('avatar');
  });

  it('returns the updated profile', async () => {
    const updated = { user_id: 'u1', avatar_url: 'https://cdn.test/a.jpg' };
    mockApi.mockResolvedValue(updated);
    const got = await uploadAvatar(getToken, { uri: 'file:///photo.jpg', mimeType: 'image/jpeg' });
    expect(got).toBe(updated);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    mockApi.mockRejectedValue(new Error('boom'));
    await expect(
      uploadAvatar(getToken, { uri: 'file:///photo.jpg', mimeType: 'image/jpeg' }),
    ).rejects.toThrow('boom');
  });

  it('asks for the slow budget, not the default — N446, a multi-megabyte body over gym wifi', async () => {
    mockApi.mockResolvedValue({});
    await uploadAvatar(getToken, { uri: 'file:///photo.jpg', mimeType: 'image/jpeg' });

    const opts = mockApi.mock.calls[0][3] as { timeoutMs?: number } | undefined;
    expect(opts?.timeoutMs).toBe(SLOW_REQUEST_TIMEOUT_MS);
    // Stated as a difference, so a mutation making them equal cannot pass.
    expect(opts?.timeoutMs).not.toBe(DEFAULT_TIMEOUT_MS);
  });
});

describe('removeAvatar', () => {
  it('sends a DELETE to /profile/avatar', async () => {
    mockApi.mockResolvedValue(undefined);
    await removeAvatar(getToken);
    expect(mockApi).toHaveBeenCalledWith(getToken, '/profile/avatar', { method: 'DELETE' });
  });

  it('propagates a rejection rather than swallowing it', async () => {
    mockApi.mockRejectedValue(new Error('boom'));
    await expect(removeAvatar(getToken)).rejects.toThrow('boom');
  });
});
