# Navigation, loading, and persistent workspace audit
Date: 2026-09-14. Baseline: `a7765ac` (`chore: bump deps`).  
Status: analysis and implementation handoff; the application has not been fixed by this report. Source locations refer to that baseline and should be rechecked before editing. Scope is local application performance, correctness, and viewing ergonomics. Security review, publishing, and Git mutations are excluded.

## NAV-01 — Session selection causes full document navigation
Priority: P1. Confidence: confirmed by current application markup and absence of a navigation interception handler; no browser navigation trace was captured in this audit.  
User symptom: switching threads takes a long time, with repeated loading and loss of the feeling of a persistent viewer.

### Evidence and call chain
- `app/components/library/LibrarySessionItem.vue:34-39` renders a plain `<a :href="destination(item.summary.id)">`. It has no click handler that invokes the router.
- `app/components/library/LibrarySearchResults.vue:22-27` does the same for exact-turn search results.
- `app/components/conversation/ConversationToolRow.vue:70-74` and `ConversationWorkEntry.vue:95-99` do the same for child conversations.
- `app/components/ui/UiIconLink.vue:14` renders ordinary anchors for application navigation. The default layout and conversation back links also use anchors.
- A search of `app/` for `preventDefault`, `navigateTo`, `router.push`, and `NuxtLink` found no global interception of these navigation clicks. Existing `preventDefault` calls handle keyboard movement, media, or minimap interaction. The about page's `NuxtLink` does not affect session anchors.
- `app/components/library/LibraryWorkspace.vue:13-18` creates and provides workspace state. Its lifecycle starts at line 40 and stops at line 41. A document navigation destroys that state, observers, expanded folders, cached pages, and SSE connection, then recreates them in the destination document.

### Why this is a real performance problem
The viewer contains code intended to preserve the sidebar while loading a selected session, but ordinary anchors bypass that client-side lifetime. Selecting an already visited session repeats document loading, SSR, hydration, sidebar initialization, and subscriptions. Browser HTTP asset caching does not preserve the destroyed Vue application state. This cost compounds NAV-02 and the full cached-session readiness read described in `01-live-data-and-performance.md`.

### Required implementation outcome
Use framework navigation for internal viewer routes while retaining real usable URLs, modifier-click behavior, keyboard activation, and open-in-new-tab behavior. Keep external content links under their existing content-link semantics. Prefer the project's normal router link component over a global click interceptor. Preserve the library workspace across session navigation and retain the expanded tree, loaded page extent, current filters, and sidebar scroll position.  
Do not stop at replacing `<a>` tags. Inspect the route-driven page's lifecycle and keying: `app/pages/session/[id].vue:20-21` captures `sessionId` and `targetTurnId` once during setup. Ensure a session-ID change creates or refreshes the correct data context; ensure a query-only target change is handled intentionally. Avoid stale session content, outstanding requests applying to a newer route, and duplicate target jumps. History/back navigation should restore useful reading context without unnecessary full reloads.

### Acceptance and regression tests
1. In a real browser, write a unique sentinel on `window`, expand a project, load its second page, and scroll its sidebar. Select session A, then B, then A. Assert that the sentinel survives and no new document request occurs for those internal transitions.
2. Assert the project remains expanded, loaded rows past the first 20 remain, and sidebar scroll position remains useful.
3. Switch A → B quickly while A's load is delayed. Only B may become the visible conversation. Repeat with a failed A request.
4. Open a search result to a distant turn and verify the correct session and turn are loaded. Repeat from an already open different session and from the same session with a different `turn` query.
5. Verify browser Back/Forward, ordinary Enter activation, modifier-click/new tab, and the copied destination URL.
6. Count active SSE streams/observers before and after repeated transitions; persistent navigation must not accumulate duplicate subscriptions.

### Why existing tests missed it
`tests/e2e/foundation.spec.ts:27` is named “hydrates and performs client-side navigation”, but asserts only destination URL and text after clicking settings links. A full document navigation satisfies those assertions. The unit workspace test mutates a mocked route inside one retained effect scope; it does not exercise a real link or document lifecycle. Add the sentinel/document-request assertions instead of treating the test's name as proof.

## NAV-02 — The destination's lazy data call still blocks server rendering on conversation work
Priority: P1 when combined with NAV-01 and expensive materialization. Confidence: source-confirmed using the installed Nuxt implementation; end-to-end time-to-first-byte was not measured.

### Evidence
- `app/pages/session/[id].vue:28-40` awaits summary and full navigator in parallel, then requests an initial 20-turn chunk. The page cannot return its data until both stages finish.
- `app/pages/session/[id].vue:43-46` calls `useLazyAsyncData` without `server: false`.
- `node_modules/nuxt/dist/app/composables/asyncData.js` defaults `opts.server` to true and registers/awaits the initial fetch during server prefetch. The `lazy` option changes client navigation scheduling; it does not mean that this call is omitted from SSR.
- `app/components/conversation/ConversationView.vue:562` initially renders all loaded initial turns, then switches to the virtualized branch on mount. The timeline report explains the extra collapsed-work serialization and remount cost.

### Root cause and scope
A loading skeleton in the template cannot provide fast server-first feedback if the server is still waiting for full materialization before sending the page. Because NAV-01 causes a new document request, the expensive server path is incurred during routine session selection. The three data requests also separately enter the live materializer, which currently reconstructs the whole warm conversation for its readiness check. Fixing only the loader text or adding another spinner cannot change this work.

### Required implementation outcome
Define and enforce separate budgets for shell readiness, summary readiness, first requested turn range, and remaining history. Choose an explicit SSR policy for session routes: either send a shell and load the selected bounded range on the client, or provide a truly bounded server payload. Preserve direct links and error handling. Separate normalized-source preparation from rich-content preparation so a selected range can render before unrelated older content is highlighted. Share/deduplicate session readiness between concurrent summary/navigator/chunk requests, while retaining revision checks.  
Navigator data should be compact and independently available. Do not make the first turn payload wait for expensive reconstruction merely to learn the recent cursor. Consider a repository-level “recent range” operation or an initial-view payload if it actually removes the dependency; avoid adding a wrapper endpoint that internally performs the same full work.

### Acceptance
- Compare direct cold session entry and warm in-app switching using separate metrics: document TTFB, shell visibility, first selected content, main-thread long tasks, and time to stable target position.
- Use sessions with the same requested 20 turns but increasingly large unrelated history/raw events. Warm selected-range work should remain bounded. Cold source indexing costs may scale with source size; report them separately rather than claiming all cold work is constant.
- Keep backend and browser measurements separate. The 2.408 ms versus 23.185 ms result in the backend report measures a synthetic in-process warm read; it is not the user's observed browser loading duration.
- Confirm SSR/hydration does not serialize the same large initial payload unnecessarily and does not mount large hidden technical payloads.

## NAV-03 — Concurrent folder expansion overwrites newer state and gives no immediate feedback
Priority: P2. Confidence: executed against the actual workspace composable with controlled asynchronous repository responses.

### Evidence
`app/composables/useLibraryWorkspace.ts:327-347` clones the current expanded set, adds the selected project/session, awaits its fetch, and only then assigns the cloned set. `LibraryProjectFolder.vue` and `LibrarySessionTree.vue` show their content/loading skeleton only when the item is already expanded. Thus the first click cannot reveal its loading skeleton while the request is outstanding. Two simultaneous expansions capture the same old set and the later completion overwrites the earlier expansion.

### Executed reproduction
The following inline probe ran with workspace Node 26 and Jiti, without changing application files. It uses the real `createLibraryWorkspace`, a real Vue effect scope, and controlled request completion. The observed output was `whileLoading []`, `afterA ["project-a"]`, `afterB ["project-b"]`: opening B erased A's expansion.

```powershell
@'
import { createJiti } from 'jiti';
import { resolve } from 'node:path';
const jiti = createJiti(resolve('audit-readonly.mjs'), { alias: {'#shared': resolve('shared')}, fsCache:false });
const {createLibraryWorkspace}=await jiti.import('./app/composables/useLibraryWorkspace.ts');
const vue=jiti('vue');
globalThis.useRoute=()=>({path:'/',query:{}});
globalThis.useRouter=()=>({replace(){}});
globalThis.useRuntimeConfig=()=>({public:{viewerMode:'live',pagefindEnabled:false}});
const gates=new Map();
globalThis.useRequestFetch=()=>async(path)=>{
  if(path==='/api/projects') return [];
  if(path==='/api/status') return {state:'ready',message:null};
  const id=new URL(path,'http://localhost').searchParams.get('projectId');
  await new Promise(resolve=>gates.set(id,resolve));
  return {items:[],nextCursor:null,total:0};
};
const scope=vue.effectScope();
const w=scope.run(()=>createLibraryWorkspace());
const a=w.toggleProject('project-a'); const b=w.toggleProject('project-b');
console.log('whileLoading',JSON.stringify([...w.expandedProjectIds.value]));
gates.get('project-a')(); await a;
console.log('afterA',JSON.stringify([...w.expandedProjectIds.value]));
gates.get('project-b')(); await b;
console.log('afterB',JSON.stringify([...w.expandedProjectIds.value]));
w.stop(); scope.stop();
'@ | & .\node_modules\node\bin\node.exe --input-type=module
```

### Required implementation outcome
Commit expansion state synchronously so loading feedback is visible immediately. Fetch page content independently and apply responses to the correct project/session/query generation. Do not reassign a stale expansion-set snapshot after an await. A late load may populate a cache, but must not reopen a node the user has since collapsed or erase another expansion. Coalesce duplicate loads and preserve error/retry behavior. Both project and subagent expansion paths need the same fix.

### Acceptance
Start expanding A and B before either request completes, resolve them in both orders, and assert both remain expanded. Collapse A before its response completes and assert it stays collapsed. Change scope/filter while a request is outstanding and assert its response cannot contaminate the new view. Assert loading feedback is visible between click and response, and retry can recover a failed fetch.

## NAV-04 — Default daily-use launcher runs the development server
Priority: P2 as a performance contributor and distribution gap. Confidence: source-confirmed; no dev-versus-production browser benchmark was run.

### Evidence and implication
`package.json` maps `dev` to `pnpm live` and `live` to `jiti scripts/live.ts`. `scripts/live.ts:97-100` always constructs `pnpm exec nuxt dev`. The README quick start recommends `pnpm live`. Consequently the normal documented viewing route includes the development module pipeline and HMR machinery. `pnpm build` creates a live production build, but the documented everyday launcher does not run it. This adds avoidable development overhead and can make first navigation/module access particularly expensive. It does not explain the other bugs and is not a substitute for fixing them.

### Required implementation outcome
Provide an explicit production serving path for routine viewing, preserving current CLI configuration, loopback binding, read-only Codex ingestion, and useful startup errors. Keep development mode available deliberately. Avoid silently building the entire app on every launch or running a static/offline server when the user requested live updates. Update documentation to distinguish development, production live serving, and offline exports. Benchmark the same content on comparable warm/cold conditions before assigning a numerical gain.

## Cross-report ownership and implementation order
- `01-live-data-and-performance.md` owns live repository/cache/materialization/reconciliation and duplicate invalidation costs.
- `02-timeline-and-rendering.md` owns virtualization, scroll correction, minimap update costs, and copy-agent-work serialization.
- `03-subagent-topology.md` owns structural parent evidence and missing expanded child pages after refresh.
- This report owns internal routing, page orchestration, expansion request/state races, and launcher behavior.
- Changes to `useLibraryWorkspace.ts` overlap these reports. One agent should integrate them, or workers must coordinate exact functions before editing. Do not merge independently rewritten copies of the entire composable.
- Correct NAV-01/NAV-02 and the backend warm-read check first, then measure again. Preserve actual cold-session progress and errors while improving perceived responsiveness.

## Verification performed for this report
Current source and installed Nuxt source were inspected. The expansion-race probe above executed successfully. Four existing UI test files passed: `libraryWorkspace.test.ts`, `libraryProjectTree.test.ts`, `librarySidebar.test.ts`, and `library.test.ts` — 21 tests total. These passes establish the current test baseline, not correctness of the newly identified cases. No full browser performance capture, production build, archive-wide export, or implementation patch was performed.
