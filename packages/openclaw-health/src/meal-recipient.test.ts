import { expect, it } from "vitest";
import { explicitMealRecipient } from "./meal-recipient.js";
it.each([
 ["Save this for Cici Claw", "Cici"],
 ["Can you log this for Mahin?", "Mahin"],
 ["Cici had this for lunch. Can you log it for her and not me", "Cici"],
 ["Mahin ate this. Log it for him", "Mahin"],
 ["What did Cici eat today?", "Cici"],
 ["What did Jobayer eat?", "Jobayer"],
 ["What did I eat today?", "self"],
 ["Log this for myself", "self"],
 ["Log it for my girlfriend", "partner"],
 ["Cici had this for lunch", "Cici"],
 ["I had two eggs", "self"],
 ["My girlfriend ate this", "partner"],
 ["What did she eat today?", "unresolved-recipient"],
 ["Log this for her", "unresolved-recipient"],
 ["Log it for me and Cici", "unresolved-recipient"],
 ["Log for both of us", "unresolved-recipient"],
 ["Yes", undefined],
 ["My favourite food is Cici's rice, log it", undefined],
])("extracts an explicit current-message recipient: %s", (text, recipient) => expect(explicitMealRecipient(text)).toBe(recipient));

import { isMealLogConfirmation } from "./confirmation.js";
it("distinguishes excluding the sender from declining the write", () => {
 expect(isMealLogConfirmation("Cici had this. Can you log it for her and not me")).toBe(true);
 expect(isMealLogConfirmation("Log this for Cici, not for me")).toBe(true);
 expect(isMealLogConfirmation("Do not log this for Cici")).toBe(false);
 expect(isMealLogConfirmation("Log this, but not yet")).toBe(false);
});
