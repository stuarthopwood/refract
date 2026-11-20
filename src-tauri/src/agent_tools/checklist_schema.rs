// `refract_checklist`: the tool's name, description and parameter schema. The Session and the
// checklist are never arguments; the handler takes the Session from the registry.

use serde_json::{json, Value};

pub const CHECKLIST: &str = "refract_checklist";

pub fn description() -> &'static str {
    "Keep the developer's checklist for this Session: a shared list of steps they can see, tick and \
add to. `create` starts one (give a unique `requestId`); `update` applies up to 20 ops all-or-none \
and needs `baseRev`; `get` reads it back. Always call `get` before you edit a checklist you have \
not read in this run, and quote the `seenRev` of the last result, not `rev`, as `baseRev`, so \
developer changes in `userChanges` reach you. This is not the working mode's plan and does not \
replace it; the OMP todo is for your own scratch tracking. Give the developer the items only they \
can do by setting `owner` to `human` when you create or add them (`agent` is the default, `either` \
lets both complete it). You cannot edit or remove what the developer wrote, or complete a step \
that is theirs. If this Session is in plan mode and the call is refused or fails, leave plan mode to \
edit the checklist; the developer can still tick it in the panel."
}

fn owner() -> Value {
    json!({
        "type": "string",
        "enum": ["agent", "human", "either"],
        "description": "Who completes the item; default agent. Use human for steps only the developer can do."
    })
}

fn new_item() -> Value {
    json!({
        "type": "object",
        "properties": {
            "text": { "type": "string", "description": "What the step is." },
            "owner": owner(),
            "requiresValue": { "type": "boolean", "description": "The developer must supply a value before it can be completed." },
            "agentCompletable": { "type": "boolean", "description": "Whether you may mark it complete." },
            "group": { "type": "string", "description": "Optional heading to group steps under." }
        },
        "required": ["text"],
        "additionalProperties": false
    })
}

fn op() -> Value {
    json!({
        "type": "object",
        "properties": {
            "op": { "type": "string", "enum": ["add", "edit", "move", "remove", "setStatus", "setValue"] },
            "id": { "type": "string", "description": "Item id from a result; not used by add." },
            "after": { "type": "string", "description": "Item id to place this one after; omit for the end (add, move)." },
            "item": new_item(),
            "text": { "type": "string" },
            "owner": owner(),
            "requiresValue": { "type": "boolean" },
            "agentCompletable": { "type": "boolean" },
            "group": { "type": "string" },
            "status": { "type": "string", "enum": ["upcoming", "in_progress", "complete"] },
            "value": { "type": "string" }
        },
        "required": ["op"],
        "additionalProperties": false
    })
}

pub fn parameters() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["create", "update", "get"] },
            "requestId": { "type": "string", "description": "Unique per structural call (create, or an update that adds, moves or removes); a retry with the same id is not applied twice." },
            "title": { "type": "string", "description": "create: the checklist title." },
            "items": { "type": "array", "maxItems": 40, "items": new_item(), "description": "create: the starting items." },
            "replace": { "type": "boolean", "description": "create: archive an unfinished checklist and start this one." },
            "baseRev": { "type": "integer", "minimum": 0, "description": "update, get: the `seenRev` of the last result you saw." },
            "ops": { "type": "array", "maxItems": crate::checklist::model::MAX_OPS, "items": op(), "description": "update: the ops, applied all or none." },
            "itemId": { "type": "string", "description": "get: read one item whole." },
            "full": { "type": "boolean", "description": "get: whole items instead of compact ones." },
            "after": { "type": "string", "description": "get: start the item list after this id." }
        },
        "required": ["action"],
        "additionalProperties": false
    })
}

#[cfg(test)]
#[path = "checklist_schema.test.rs"]
mod tests;
