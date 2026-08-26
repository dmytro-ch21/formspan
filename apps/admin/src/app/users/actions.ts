"use server";

import { revalidatePath } from "next/cache";

import { assertAdmin } from "@/lib/admin";
import { ApiError, clearAvatar } from "@/lib/api";

/**
 * N12's moderation answer, and this app's write surface for it: `assertAdmin`
 * because a server action is a POST endpoint the router exposes on its own —
 * `users/layout.tsx` gates what renders, not what a form can POST to — the
 * same reasoning `/content`'s actions already document.
 *
 * Takes the user id rather than a form, unlike the content actions: there is
 * exactly one field, it is not user-editable text, and it is already known
 * from the page — a hidden form input would just be this same value spelled
 * as markup.
 */
export async function clearAvatarAction(userID: string): Promise<{ ok: true } | { ok: false; message: string }> {
  await assertAdmin();
  try {
    await clearAvatar(userID);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof ApiError && err.detail ? err.detail : "Could not remove the avatar.",
    };
  }
  // The page reads has_avatar from getUserDetail, which this write just made
  // stale — without revalidating, the button would still show "Remove
  // avatar" for an account that no longer has one until the operator
  // manually reloads.
  revalidatePath(`/users/${userID}`);
  return { ok: true };
}
