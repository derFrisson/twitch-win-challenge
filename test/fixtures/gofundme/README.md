# GoFundMe fixtures

Captured live with `curl` on **2026-08-21** from `POST https://graphql.gofundme.com/graphql`,
from a real (small, German, EUR) campaign.

**No test may hit the network.** The campaign is live and its totals move; a test asserting €475
would fail next week for the right reason at the wrong time. These files are the contract the
parser is written against, frozen at the date above.

The endpoint is undocumented, introspection is disabled, and the shape can change without notice.
When it does, re-capture these files and the parser tests will tell you what moved.

| file | what it is |
|---|---|
| `totals.json` | the §3.1 totals query — drives the clock |
| `donations.json` | the §3.2 list, all 7 edges, summing to exactly the `currentAmount` in `totals.json` |
| `not-found.json` | **a slug that does not exist: HTTP 200 with `data.fundraiser: null`, not a 404** |
| `validation-error.json` | a rejected query: HTTP 400 with a `GRAPHQL_VALIDATION_FAILED` code |

The fund name, slug, donor names and donation ids are fictionalised to keep the campaign and
its donors private. Amounts, currencies, timestamps and structure are verbatim — the exclusion
test (§4.1) keys on the donation id `9000000002`, never on a name.
