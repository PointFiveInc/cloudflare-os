import { describe, expect, it } from "vitest";
import type { CollaboratorInfo } from "@gadgets/workshop-shared/api";
import {
  atMentionGrants, atMentionSpans, atMentionToken, findAtMentions, otherPeopleInChat,
} from "@gadgets/workshop-shared/p5-at-mentions";

const bob = { id: "bob@pointfive.co", name: "Bob" };
const bobSmith = { id: "bob.smith@example.com", name: "Bob Smith" };
const carol = { id: "carol@example.com", name: "Carol" };
const jose = { id: "jose@example.com", name: "José" };

const ids = (people: readonly { id: string }[]) => people.map(person => person.id);
const collaborator = (profile: { id: string; name: string }, role: CollaboratorInfo["role"]): CollaboratorInfo =>
  ({ profile: { type: "user", ...profile }, addedBy: [], role });

describe("findAtMentions", () => {
  it("finds a name at the start of the text and after a space", () => {
    expect(ids(findAtMentions("@Bob can you look", [bob, carol]))).toEqual([bob.id]);
    expect(ids(findAtMentions("thanks @Carol", [bob, carol]))).toEqual([carol.id]);
    expect(ids(findAtMentions("@Bob and @Carol, see this", [bob, carol]))).toEqual([bob.id, carol.id]);
  });

  it("finds a name followed by punctuation, and a name after an opening bracket", () => {
    for (let text of ["@Bob, hi", "hi @Bob.", "@Bob!", "@Bob?", "@Bob: here", "(@Bob)", "\"@Bob\""]) {
      expect(ids(findAtMentions(text, [bob])), text).toEqual([bob.id]);
    }
  });

  it("matches any case", () => {
    expect(ids(findAtMentions("@bob", [bob]))).toEqual([bob.id]);
    expect(ids(findAtMentions("@BOB SMITH", [bobSmith]))).toEqual([bobSmith.id]);
  });

  it("matches names with spaces and regex characters literally", () => {
    let dotted = { id: "a", name: "J.R. (Ops)+" };
    let spaced = { id: "b", name: "  Mary Ann  " };
    expect(ids(findAtMentions("ask @j.r. (ops)+ and @Mary Ann", [dotted, spaced]))).toEqual(["a", "b"]);
    expect(findAtMentions("ask @jXr. (ops)+", [dotted])).toEqual([]);
  });

  it("takes the longest listed name at an @", () => {
    expect(ids(findAtMentions("@Bob Smith please", [bob, bobSmith]))).toEqual([bobSmith.id]);
    expect(ids(findAtMentions("@Bob please", [bob, bobSmith]))).toEqual([bob.id]);
    expect(ids(findAtMentions("@Bob Smithers", [bob, bobSmith]))).toEqual([bob.id]);
  });

  it("returns everyone who shares the matched name, each once", () => {
    let otherBob = { id: "bob@example.com", name: "bob" };
    expect(ids(findAtMentions("@Bob then @bob again", [bob, otherBob]))).toEqual([bob.id, otherBob.id]);
  });

  it("finds no mention inside a word or an address, nor a name that runs on", () => {
    expect(findAtMentions("a@bob", [bob])).toEqual([]);
    expect(findAtMentions("write to bob@pointfive.co", [bob])).toEqual([]);
    expect(findAtMentions("@Bobby", [bob])).toEqual([]);
    expect(findAtMentions("@Bob2", [bob])).toEqual([]);
    expect(findAtMentions("no one here", [bob])).toEqual([]);
    expect(findAtMentions("@ ", [{ id: "blank", name: "  " }])).toEqual([]);
  });

  it("reads letters beyond ASCII as word characters", () => {
    expect(ids(findAtMentions("@José, mira", [jose]))).toEqual([jose.id]);
    expect(findAtMentions("é@Bob", [bob])).toEqual([]);
    expect(findAtMentions("@Bobé", [bob])).toEqual([]);
    expect(ids(findAtMentions("x_@Bob", [bob]))).toEqual([bob.id]);
  });

  it("reads a dotted capital I right before an @ as a word character, as atMentionToken does", () => {
    expect(findAtMentions("İ@Bob", [bob])).toEqual([]);
    expect(atMentionToken("İ@Bob", 5)).toBeNull();
  });
});

describe("atMentionSpans", () => {
  it("gives each mention's place in the text, past its name", () => {
    let text = "hi @Bob, ask @carol too";
    let spans = atMentionSpans(text, [bob, carol]);
    expect(spans.map(span => [span.start, span.end, ids(span.people)]))
        .toEqual([[3, 7, [bob.id]], [13, 19, [carol.id]]]);
    expect(spans.map(span => text.slice(span.start, span.end))).toEqual(["@Bob", "@carol"]);
  });

  it("spans the longest listed name, with everyone who shares it", () => {
    let otherBobSmith = { id: "smith@pointfive.co", name: "bob smith" };
    let spans = atMentionSpans("@Bob Smith please", [bob, bobSmith, otherBobSmith]);
    expect(spans.map(span => [span.start, span.end, ids(span.people)]))
        .toEqual([[0, 10, [bobSmith.id, otherBobSmith.id]]]);
  });

  it("counts places in the text itself, where lower case would be longer", () => {
    let text = "İstanbul team, @Bob";
    expect("İ".toLowerCase()).toHaveLength(2);
    let spans = atMentionSpans(text, [bob]);
    expect(spans.map(span => text.slice(span.start, span.end))).toEqual(["@Bob"]);
  });

  it("gives no span where findAtMentions finds no one", () => {
    expect(atMentionSpans("a@bob and @Bobby", [bob])).toEqual([]);
  });
});

describe("atMentionToken", () => {
  it("gives the token the caret ends", () => {
    expect(atMentionToken("@bo", 3)).toEqual({ start: 0, query: "bo" });
    expect(atMentionToken("x_@bo", 5)).toEqual({ start: 2, query: "bo" });
    expect(atMentionToken("hi @bob there", 6)).toEqual({ start: 3, query: "bo" });
    expect(atMentionToken("hi @", 4)).toEqual({ start: 3, query: "" });
    expect(atMentionToken("@Mary Ann", 9)).toEqual({ start: 0, query: "Mary Ann" });
  });

  it("gives none after a word character", () => {
    expect(atMentionToken("é@bo", 4)).toBeNull();
    expect(atMentionToken("bob@x", 5)).toBeNull();
  });

  it("gives none at caret 0", () => {
    expect(atMentionToken("@bo", 0)).toBeNull();
  });

  it("ends at a new line and at 41 characters", () => {
    expect(atMentionToken("@bo\nhi", 6)).toBeNull();
    expect(atMentionToken(`@${"a".repeat(40)}`, 41)).toEqual({ start: 0, query: "a".repeat(40) });
    expect(atMentionToken(`@${"a".repeat(41)}`, 42)).toBeNull();
  });

  it("opens exactly where findAtMentions reads a mention", () => {
    for (let text of ["@bo", "x_@bo", "é@bo", "bob@bo", "(@bo", "1@bo", "hi @bo", "@@bo"]) {
      let named = findAtMentions(text, [{ id: "bo", name: "bo" }]);
      expect(atMentionToken(text, text.length) !== null, text).toBe(named.length > 0);
    }
  });
});

describe("otherPeopleInChat", () => {
  const owner = { id: "owner@pointfive.co", name: "Owner" };
  const collaborators = [collaborator(bob, "build"), collaborator(carol, "use"), collaborator(bobSmith, "build")];

  it("lists the owner and the \"Workspace\" collaborators, never a \"Gadget only\" one", () => {
    expect(ids(otherPeopleInChat(owner, collaborators, "someone@pointfive.co")))
        .toEqual([owner.id, bob.id, bobSmith.id]);
  });

  it("leaves out the sender, owner or collaborator", () => {
    expect(ids(otherPeopleInChat(owner, collaborators, owner.id))).toEqual([bob.id, bobSmith.id]);
    expect(ids(otherPeopleInChat(owner, collaborators, bob.id))).toEqual([owner.id, bobSmith.id]);
  });
});

describe("atMentionGrants", () => {
  const danCohen = { id: "dan.cohen@pointfive.co", name: "Dan Cohen" };
  const dan = { id: "dan@example.com", name: "Dan", email: "dan@example.com" };
  const dana = { id: "dana@example.com", name: "Dana Levi", email: "dana@example.com" };
  const eli = { id: "eli@example.com", name: "Eli Ron", email: "eli@example.com" };

  it("grants a pick the text names, and gives back the pick itself", () => {
    let granted = atMentionGrants("@Dana Levi please look", [bob], [dana]);
    expect(granted).toEqual([dana]);
    expect(granted[0]).toBe(dana);
  });

  it("grants nobody for a name typed and not picked, though it names someone in the chat", () => {
    expect(atMentionGrants("@Bob and @Dana Levi", [bob], [])).toEqual([]);
    expect(atMentionGrants("@Bob and @Dana Levi", [bob], [dana])).toEqual([dana]);
  });

  it("grants nobody for a pick whose name only starts a longer name in the chat", () => {
    expect(atMentionGrants("@Dan Cohen the numbers are in", [danCohen], [dan])).toEqual([]);
    expect(atMentionGrants("@Dan the numbers are in", [danCohen], [dan])).toEqual([dan]);
  });

  it("grants nobody for a pick the text no longer names", () => {
    expect(atMentionGrants("the numbers are in", [bob], [dana])).toEqual([]);
    expect(atMentionGrants("dana@example.com has them", [bob], [dana])).toEqual([]);
  });

  it("grants each pick once, in the order the text names them", () => {
    expect(atMentionGrants("@Eli Ron, @Dana Levi, and again @Eli Ron", [bob], [dana, eli])).toEqual([eli, dana]);
  });
});
