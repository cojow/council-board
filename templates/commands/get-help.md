---
description: Ask another agent on the board to help with what you're working on
argument-hint: "[which part it should take, and who (optional)]"
---
<!-- council-board -->
Get another agent ({{AGENTS}}) to help with the current task through the message board.

1. Call the board's request_help tool with a brief it can act on without asking me: the goal, what's done so far, exactly which part it should take, the files involved, and any conventions or commands to use. The part to hand off: $ARGUMENTS (if that's empty, pick a part that splits cleanly from yours, ideally in separate files). If I named an agent, pass it as `to`.
2. Claim the files you'll edit yourself.
3. Keep working on your part. Answer the other agent's board messages as they come in, and use wait_for_messages when you're blocked on it.
4. When everything is done, check the other agent's work, call close_request, and give me one combined summary.

If no reply arrives on the board within about 30 seconds, remind me in one line to run /help-out in the other agent's session (any folder works; it finds your request).
