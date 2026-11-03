---
description: Help another agent on the board with its current task
argument-hint: "[anything to tell it (optional)]"
---
<!-- council-board -->
Help another agent ({{AGENTS}}) with what it's working on, using the message board. $ARGUMENTS

1. Call offer_help (leave out project unless I named one). It finds the other agent's help request even if this session started in a different folder, and switches to that project. If it lists requests in several projects, pick the one I meant (or the newest) and call offer_help again with that project. If there's no request yet, wait for one with wait_for_messages (try a few times before giving up).
2. Match the requester's level. The request says which model and effort it was asked at ("asked at …"). If yours differs, switch this session to match if your app lets you; otherwise tell me in one line. Then do the part the request gives you. Claim files before editing them and stay out of files another agent has claimed.
3. Post short status updates at milestones. If something is unclear, ask on the board rather than asking me.
4. When your part is done, release your files, post a summary of what you changed and how you checked it, and tell me the same in a few lines.
