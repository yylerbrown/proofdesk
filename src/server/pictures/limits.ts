// How many pictures a message and a ticket may hold, and how large each may be. The upload
// parser in app.ts cuts a request off at the same sizes, so an oversized picture is never
// held in memory whole. The ticket service checks them again when it saves.

export type PictureLimits = {
  /** The largest picture, in bytes. */
  maxBytes: number;
  /** The most pictures sent with one message, or with a new ticket's description. */
  perMessage: number;
  /** The most pictures one ticket holds, its description and messages together. */
  perTicket: number;
  /**
   * The most bytes of pictures one person may add in all, across every ticket. Pictures are
   * kept in the database, so this and the site's total keep its disk from filling.
   */
  personTotalBytes: number;
  /** The most bytes of pictures the whole site keeps. */
  siteTotalBytes: number;
  /**
   * The shared demo only: the most pictures its visitors may add in all, until the demo next
   * resets. Undefined on a real site.
   */
  visitorTotal?: number;
};

const MB = 1024 * 1024;

export const PICTURE_LIMITS: PictureLimits = {
  maxBytes: 2 * MB,
  perMessage: 4,
  perTicket: 20,
  personTotalBytes: 40 * MB,
  siteTotalBytes: 300 * MB,
};

/** The shared public demo keeps less, so it can never become a place to host pictures. */
export const DEMO_PICTURE_LIMITS: PictureLimits = {
  maxBytes: 1 * MB,
  perMessage: 2,
  perTicket: 20,
  // The demo's visitors share three people, so visitorTotal is the limit that binds here.
  personTotalBytes: 60 * MB,
  siteTotalBytes: 60 * MB,
  visitorTotal: 40,
};

/** The limits for this server. */
export function pictureLimitsFor(demo: boolean): PictureLimits {
  return demo ? DEMO_PICTURE_LIMITS : PICTURE_LIMITS;
}

/** The size limit in words, such as "2 MB". */
export function sizeInWords(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

/** The one plain sentence for each refusal. Each names its limit. */
export const PICTURE_REFUSALS = {
  notAPicture: "Each picture must be a PNG, JPEG, GIF or WebP image.",
  tooLarge: (limits: PictureLimits) =>
    `Each picture must be at most ${sizeInWords(limits.maxBytes)}.`,
  tooManyInMessage: (limits: PictureLimits) =>
    `Attach at most ${limits.perMessage} pictures at a time.`,
  tooManyOnTicket: (limits: PictureLimits) =>
    `A ticket holds at most ${limits.perTicket} pictures.`,
  personFull: (limits: PictureLimits) =>
    `You can add at most ${sizeInWords(limits.personTotalBytes)} of pictures in all.`,
  siteFull: (limits: PictureLimits) =>
    `This site holds at most ${sizeInWords(limits.siteTotalBytes)} of pictures in all.`,
  demoFull: (limits: PictureLimits) =>
    `This shared demo holds at most ${limits.visitorTotal} visitors' pictures until it next resets.`,
};

/**
 * What the page shows in place of a picture another visitor added on the shared demo. That
 * picture's bytes are never sent to anyone else.
 */
export const SHOWN_ONLY_TO_UPLOADER =
  "A picture, shown only to the visitor who added it on this shared demo.";
