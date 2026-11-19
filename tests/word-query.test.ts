import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db.js";
import {
  FILLER_WORDS,
  FUNCTION_WORDS,
  listSearchMatch,
  searchWords,
  splitWords,
  titleWords,
} from "../src/server/tickets/word-query.js";

// Typed text into words, and words into a query for the word index. Pure functions, except the
// last test, which gives the queries to the database's own word index.

describe("splitting text into words", () => {
  it("takes runs of letters and digits, lower-cased, and drops everything else", () => {
    expect(splitWords("Can't sign-in on my iPhone 15!")).toEqual([
      "can",
      "t",
      "sign",
      "in",
      "on",
      "my",
      "iphone",
      "15",
    ]);
    expect(splitWords("Café crème")).toEqual(["café", "crème"]);
    expect(splitWords(' %_ "" * ( ) ')).toEqual([]);
  });
});

describe("the two word lists", () => {
  it("are lower-case single words, and no word is on both", () => {
    for (const word of [...FUNCTION_WORDS, ...FILLER_WORDS]) {
      expect(splitWords(word)).toEqual([word]);
    }
    expect([...FUNCTION_WORDS].filter((word) => FILLER_WORDS.has(word))).toEqual([]);
  });

  it("leave function words out of a search, and keep filler words in it", () => {
    expect(searchWords("Cannot sign in on my phone")).toEqual(["sign", "phone"]);
    expect(searchWords("It doesn't work")).toEqual(["work"]);
  });

  it("leave both out when comparing titles", () => {
    expect(titleWords("Printer is broken")).toEqual(["printer"]);
    expect(titleWords("The page is wrong, please help")).toEqual(["page"]);
    expect(titleWords("Sign up page")).toEqual(["sign", "page"]);
  });
});

describe("the words a search looks for", () => {
  it("keeps words of two characters or more, each once, at most eight", () => {
    expect(searchWords("a b cd ef ef")).toEqual(["cd", "ef"]);
    const many = "one two three four five six seven eight nine ten";
    expect(searchWords(many)).toEqual(many.split(" ").slice(0, 8));
  });
});

describe("the query a list search gives the word index", () => {
  it("asks for every word, in any order, and finds longer words that start with the last", () => {
    expect(listSearchMatch("sign in phone")).toBe('"sign" AND "phone"*');
    expect(listSearchMatch("reset pass")).toBe('"reset" AND "pass"*');
  });

  it("adds no star to a last word shorter than three characters", () => {
    expect(listSearchMatch("printer ab")).toBe('"printer" AND "ab"');
  });

  it("quotes every word, so nothing typed becomes query syntax", () => {
    expect(listSearchMatch('"exact" title* OR NOT (')).toBe('"exact" AND "title"*');
    expect(listSearchMatch("NEAR(a b) col:word ^start")).toBe(
      '"near" AND "col" AND "word" AND "start"*',
    );
  });

  it("is null when no word is left, so the search is a plain text search only", () => {
    expect(listSearchMatch("")).toBeNull();
    expect(listSearchMatch("%")).toBeNull();
    expect(listSearchMatch("_")).toBeNull();
    expect(listSearchMatch("on my")).toBeNull();
  });

  it("is null for the form of a ticket key, in any case and with spaces around", () => {
    for (const typed of ["SUP-4", "sup-4", " Sup-99 ", "ABC-007"]) {
      expect(listSearchMatch(typed), typed).toBeNull();
    }
    // Words that only hold a key are still words.
    expect(listSearchMatch("see SUP-3")).toBe('"see" AND "sup"*');
  });

  it("runs in the word index without an error, whatever was typed", () => {
    const db = openDatabase(":memory:");
    db.exec(
      `CREATE VIRTUAL TABLE t USING fts5(title, tokenize = 'porter unicode61 remove_diacritics 2');
       INSERT INTO t (rowid, title) VALUES (1, 'Cannot sign in on my phone'),
         (2, 'Password reset email never arrives'), (3, 'Café crème');`,
    );
    const found = (q: string) =>
      db
        .prepare("SELECT rowid FROM t WHERE t MATCH ? ORDER BY rowid")
        .all(listSearchMatch(q))
        .map((row) => (row as { rowid: number }).rowid);
    expect(found("sign in phone")).toEqual([1]);
    expect(found("signing phone")).toEqual([1]);
    expect(found("password email")).toEqual([2]);
    expect(found("reset pass")).toEqual([2]);
    expect(found("cafe creme")).toEqual([3]);
    expect(found('"exact" title* OR NOT (')).toEqual([]);
    expect(found("NEAR(a b) col:word ^start")).toEqual([]);
    db.close();
  });
});
