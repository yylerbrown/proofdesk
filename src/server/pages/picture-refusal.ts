// A form that was refused after pictures were chosen comes back with the typed text, but the
// browser has dropped the chosen files, so the line under the form says to choose them again.

/** The words that end every line about pictures on a refused form. */
export const CHOOSE_AGAIN = "Choose the pictures again.";

/** A message must have words; pictures alone are not a message. */
export const WORDS_NEEDED = "A message needs words as well as pictures.";

/** Said when the form was refused for something else and its pictures were not kept. */
export const NOT_KEPT = "The pictures were not saved.";

/**
 * The line about pictures on the new ticket form after a refused post, or null when there is
 * nothing to say. pictureError is the sentence that names the limit a picture broke, if one did.
 */
export function ticketFormPictureLine(
  pictureError: string | undefined,
  picturesSent: boolean,
): string | null {
  if (pictureError !== undefined) return `${pictureError} ${CHOOSE_AGAIN}`;
  if (picturesSent) return `${NOT_KEPT} ${CHOOSE_AGAIN}`;
  return null;
}

/**
 * The one line under the message box after a refused message. error is what the rules said;
 * pictureError is set when it was the pictures they refused.
 */
export function messageRefusalLine(
  error: string,
  pictureError: string | undefined,
  picturesSent: boolean,
  body: string,
): string {
  if (pictureError !== undefined) return `${pictureError} ${CHOOSE_AGAIN}`;
  if (!picturesSent) return error;
  if (body.trim() === "") return `${WORDS_NEEDED} ${CHOOSE_AGAIN}`;
  return `${error} ${NOT_KEPT} ${CHOOSE_AGAIN}`;
}
