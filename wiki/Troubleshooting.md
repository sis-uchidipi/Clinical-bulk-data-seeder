# Troubleshooting

| What you see | Cause | What to do |
|---|---|---|
| The page has no styles or logo | `ui/index.html` was opened from disk | Open http://localhost:4100/ |
| `Facility X is not one of <user>'s facilities` | The user has no access to that facility | Use one of the IDs listed in the message, or another user |
| Header shows "(name not verified)" | The environment didn't return the user's facility list | Check the facility ID yourself before running |
| `not signed in` after a while | The server was restarted, or the session was idle for 8 hours | Sign in again |
| Check setup: not enough slots | Too many cases for the picked days and rooms | Pick more days |
| `Room is double booked` | Another case already uses that room and time | Retry failed, or pick other days |
| Cases don't show in Cases to Code | The facility has no active physician, or the case wasn't discharged | Check the case row's status and the physician list |
| Charged cases don't show in Patient Statements | The facility's statement settings exclude them, for example a minimum balance | Raise the charge amount, or check the facility's statement settings |
| Case flags: lock busy | Someone else is editing Case Flagging | The seeder retries with backoff. Try again later if it still fails |

Each failed case shows the step that failed and the server's own message. The full call log is under **Runs**.
