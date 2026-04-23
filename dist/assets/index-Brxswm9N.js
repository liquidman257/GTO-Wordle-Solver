(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const o of document.querySelectorAll('link[rel="modulepreload"]'))r(o);new MutationObserver(o=>{for(const l of o)if(l.type==="childList")for(const d of l.addedNodes)d.tagName==="LINK"&&d.rel==="modulepreload"&&r(d)}).observe(document,{childList:!0,subtree:!0});function s(o){const l={};return o.integrity&&(l.integrity=o.integrity),o.referrerPolicy&&(l.referrerPolicy=o.referrerPolicy),o.crossOrigin==="use-credentials"?l.credentials="include":o.crossOrigin==="anonymous"?l.credentials="omit":l.credentials="same-origin",l}function r(o){if(o.ep)return;o.ep=!0;const l=s(o);fetch(o.href,l)}})();const $=242,U=14;function B(e){return e.trim().toLowerCase()}function z(e){return/^[a-z]{5}$/.test(B(e))}async function D(e){const t=await fetch(e);if(!t.ok)throw new Error(`Failed to load word list: ${e}`);const s=await t.text();return[...new Set(s.split(/\r?\n/).map(r=>r.trim().toLowerCase()).filter(r=>/^[a-z]{5}$/.test(r)))].sort()}function _(e){return e==="correct"?"G":e==="present"?"Y":e==="absent"?"B":"?"}function K(e,t){const s=["B","B","B","B","B"],r={};for(let o=0;o<5;o++)e[o]===t[o]?s[o]="G":r[t[o]]=(r[t[o]]??0)+1;for(let o=0;o<5;o++){if(s[o]==="G")continue;const l=e[o];(r[l]??0)>0&&(s[o]="Y",r[l]--)}return s.join("")}function H(e,t){const s=[0,0,0,0,0],r={};for(let o=0;o<5;o++)e[o]===t[o]?s[o]=2:r[t[o]]=(r[t[o]]??0)+1;for(let o=0;o<5;o++){if(s[o]===2)continue;const l=e[o];(r[l]??0)>0&&(s[o]=1,r[l]--)}return s[0]+s[1]*3+s[2]*9+s[3]*27+s[4]*81}function Y(e,t){if(!z(t.word))return!0;const s=K(t.word,e);for(let r=0;r<5;r++){const o=t.marks[r];if(o==="unknown")continue;const l=_(o);if(s[r]!==l)return!1}return!0}function V(e,t){return e.filter(s=>{for(const r of t)if(!Y(s,r))return!1;return!0})}function M(e,t){const s=new Map;for(const r of t){const o=H(e,r),l=s.get(o);l?l.push(r):s.set(o,[r])}return s}function X(e,t){const s=M(e,t),r=t.length;let o=0,l=0,d=0,a=0;for(const c of s.values()){const i=c.length,f=i/r;o+=-f*Math.log2(f),l+=f*i,d=Math.max(d,i),i===1&&a++}return{buckets:s,entropy:o,expectedRemaining:l,worstBucket:d,singletonCount:a,splitCount:s.size}}function S(e){return e.slice().sort().join("|")}function Z(e){const t=new Map,s=new Map;function r(l){if(l.length<=1)return 1;const d=S(l),a=t.get(d);if(a!==void 0)return a;let c=1/0;for(const i of e){const f=M(i,l);let h=0,g=!1;for(const[b,w]of f){let m;if(b===$&&w.length===1&&w[0]===i)m=1;else{if(w.length===l.length){g=!0;break}m=1+r(w)}if(h=Math.max(h,m),h>=c)break}g||(c=Math.min(c,h))}return Number.isFinite(c)||(c=l.length),t.set(d,c),c}function o(l){if(l.length<=1)return 1;const d=S(l),a=s.get(d);if(a!==void 0)return a;const c=l.length;let i=1/0;for(const f of e){const h=M(f,l);let g=0,b=!1;for(const[w,m]of h){let p;if(w===$&&m.length===1&&m[0]===f)p=1;else{if(m.length===l.length){b=!0;break}p=1+o(m)}g+=m.length/c*p}b||(i=Math.min(i,g))}return Number.isFinite(i)||(i=l.length),s.set(d,i),i}return{valueWorst:r,valueExpected:o}}function J(e){return e<=1?1:e<=2?2:e<=6?3:e<=18?4:e<=54?5:6}function Q(e,t,s,r,o){const l=s.has(e),{buckets:d,entropy:a,expectedRemaining:c,worstBucket:i,singletonCount:f,splitCount:h}=X(e,t);let g=0,b=0;const w=t.length<=U;if(w){for(const[m,p]of d){const C=m===$&&p.length===1&&p[0]===e?1:1+o.valueWorst(p);g=Math.max(g,C)}for(const[m,p]of d){const C=m===$&&p.length===1&&p[0]===e?1:1+o.valueExpected(p);b+=p.length/t.length*C}}else for(const[m,p]of d){const C=m===$&&p.length===1&&p[0]===e?1:1+J(p.length);g=Math.max(g,C),b+=p.length/t.length*C}return{guess:e,possibleAnswer:l,exact:w,worstTurns:g,expectedTurns:b,entropy:a,expectedRemaining:c,worstBucket:i,singletonCount:f,splitCount:h}}function O(e,t){return e.worstTurns!==t.worstTurns?e.worstTurns-t.worstTurns:e.expectedTurns!==t.expectedTurns?e.expectedTurns-t.expectedTurns:e.worstBucket!==t.worstBucket?e.worstBucket-t.worstBucket:e.expectedRemaining!==t.expectedRemaining?e.expectedRemaining-t.expectedRemaining:t.entropy!==e.entropy?t.entropy-e.entropy:t.singletonCount!==e.singletonCount?t.singletonCount-e.singletonCount:t.splitCount!==e.splitCount?t.splitCount-e.splitCount:t.possibleAnswer!==e.possibleAnswer?Number(t.possibleAnswer)-Number(e.possibleAnswer):e.guess.localeCompare(t.guess)}function T(e,t){return Math.abs(e-t)<1e-7}function ee(e,t){if(e.length===0)return[];const s=Z(t),r=new Set(e);return t.map(o=>Q(o,e,r,t,s)).sort(O)}function te(e,t,s=10){if(e.length===0)return[];if(t<=10){const r=e[0];return e.filter(o=>T(o.worstTurns,r.worstTurns)&&T(o.expectedTurns,r.expectedTurns)).slice(0,s)}return e.slice(0,s)}const G=10,R=6,k=5,n={solutions:[],grid:q(),selectedRow:0,selectedCol:0,controlsOpen:!1,candidates:[],rankedCandidates:[],allRankings:[],recommendations:[],messages:[],loading:!0,calculating:!1,error:"",hasCalculated:!1},F=document.querySelector("#app");if(!F)throw new Error("Missing #app element.");const ne=F,re=[["q","w","e","r","t","y","u","i","o","p"],["a","s","d","f","g","h","j","k","l"],["enter","z","x","c","v","b","n","m","backspace"]],x=["unknown","absent","present","correct"];function q(){return Array.from({length:R},()=>Array.from({length:k},()=>({letter:"",mark:"unknown"})))}function N(e){return e.replace(/[&<>"']/g,t=>{switch(t){case"&":return"&amp;";case"<":return"&lt;";case">":return"&gt;";case'"':return"&quot;";case"'":return"&#039;";default:return t}})}function v(e,t){n.selectedRow=Math.max(0,Math.min(R-1,e)),n.selectedCol=Math.max(0,Math.min(k-1,t))}function y(e,t){return n.grid[e][t]}function W(e){return e.map(t=>t.letter).join("")}function se(e){return/^[a-z]{5}$/.test(W(e))}function oe(){return n.grid.filter(se).map(e=>({word:W(e),marks:e.map(t=>t.mark)}))}function le(){return n.grid.flatMap((e,t)=>{const s=e.filter(r=>!!r.letter).length;return s>0&&s<k?[t+1]:[]})}function ce(e,t,s){v(e,t);const r=y(e,t);r.letter=s.toLowerCase(),r.mark=r.mark??"unknown",n.selectedCol<k-1&&n.selectedCol++,u()}function j(e){ce(n.selectedRow,n.selectedCol,e)}function I(){let e=n.selectedRow,t=n.selectedCol,s=y(e,t);!s.letter&&t>0&&(t--,v(e,t),s=y(e,t)),s.letter="",s.mark="unknown",u()}function E(e,t,s){v(e,t);const r=y(e,t);if(!r.letter){u();return}const l=(x.indexOf(r.mark)+s+x.length)%x.length;r.mark=x[l],u()}function ie(e){const t=B(e).replace(/[^a-z]/g,"").slice(0,5),s=n.grid[n.selectedRow];for(let r=0;r<k;r++)s[r].letter=t[r]??"",s[r].mark="unknown";n.selectedCol=Math.min(t.length,k-1),u()}function ae(){for(const e of n.grid[n.selectedRow])e.mark="unknown";u()}function ue(){for(let e=R-1;e>=0;e--)if(n.grid[e].some(s=>s.letter||s.mark!=="unknown")){n.grid[e]=Array.from({length:k},()=>({letter:"",mark:"unknown"})),v(e,0),u();return}}function A(){n.grid=q(),n.selectedRow=0,n.selectedCol=0,n.candidates=[...n.solutions],n.rankedCandidates=[],n.allRankings=[],n.recommendations=[],n.messages=[],n.hasCalculated=!1,u()}function de(e){if(e==="enter"){L();return}if(e==="backspace"){I();return}/^[a-z]$/.test(e)&&j(e)}function fe(e,t,s){const r=[];return t.length>0&&r.push({type:"warning",text:`Incomplete rows are ignored until all 5 letters are filled: ${t.join(", ")}.`}),e.length===0?(r.push({type:"info",text:"Fill one or more complete rows, then press Calculate Guesses."}),r):s.length===0?(r.push({type:"error",text:"Contradiction detected: no possible answers match the current rows."}),r):(s.length===1&&r.push({type:"info",text:`Only one answer fits: ${s[0].toUpperCase()}.`}),r)}function L(){n.loading||n.calculating||(n.calculating=!0,u(),window.setTimeout(()=>{const e=oe(),t=le();n.candidates=V(n.solutions,e),n.allRankings=ee(n.candidates,n.solutions),n.recommendations=te(n.allRankings,n.candidates.length,G),n.rankedCandidates=n.allRankings.filter(s=>s.possibleAnswer).sort(O),n.messages=fe(e,t,n.candidates),n.hasCalculated=!0,n.calculating=!1,u()},0))}function P(e){return e==="correct"?"tile tile-correct":e==="present"?"tile tile-present":e==="absent"?"tile tile-absent":"tile tile-empty"}function pe(e){return e==="correct"?"correct":e==="present"?"present":e==="absent"?"absent":"unknown"}function ge(){return n.messages.length===0?"":`
    <div class="message-stack">
      ${n.messages.map(e=>`
            <div class="solver-message solver-message-${e.type}">
              ${N(e.text)}
            </div>
          `).join("")}
    </div>
  `}function me(){return`
    <div class="wordle-board">
      ${n.grid.map((e,t)=>`
            <div class="board-row">
              ${e.map((s,r)=>{const o=t===n.selectedRow&&r===n.selectedCol;return`
                    <button
                      class="board-tile input-board-tile ${P(s.mark)} ${o?"selected-tile":""}"
                      data-cell-row="${t}"
                      data-cell-col="${r}"
                      title="Click to select. When selected, click/right-click/scroll to cycle state."
                      aria-label="Row ${t+1}, column ${r+1}, ${pe(s.mark)}"
                    >
                      ${s.letter.toUpperCase()}
                    </button>
                  `}).join("")}
            </div>
          `).join("")}
    </div>
  `}function he(){const e={},t={unknown:0,absent:1,present:2,correct:3};for(const s of n.grid)for(const r of s){if(!r.letter||r.mark==="unknown")continue;const o=e[r.letter]??"unknown";t[r.mark]>t[o]&&(e[r.letter]=r.mark)}return e}function we(){const e=he();return`
    <div class="keyboard">
      ${re.map(t=>`
          <div class="keyboard-row">
            ${t.map(s=>{const r=s.length===1?e[s]??"unknown":"unknown",o=s.length===1?`key ${P(r)}`:"key key-wide",l=s==="backspace"?"⌫":s.toUpperCase();return`
                  <button class="${o}" data-key="${s}">
                    ${l}
                  </button>
                `}).join("")}
          </div>
        `).join("")}
    </div>
  `}function ke(e,t){if(t<=1)return`
      background: linear-gradient(
        90deg,
        hsla(120, 78%, 52%, 0.26) 0%,
        rgba(255, 255, 255, 0.98) 88%
      );
      border-color: hsla(120, 62%, 24%, 0.62);
    `;const r=120-120*(e/Math.max(1,t-1));return`
    background: linear-gradient(
      90deg,
      hsla(${r.toFixed(1)}, 82%, 58%, 0.22) 0%,
      rgba(255, 255, 255, 0.98) 88%
    );
    border-color: hsla(${r.toFixed(1)}, 68%, 24%, 0.58);
  `}function be(){return n.hasCalculated?n.candidates.length===0?'<div class="empty warning">No candidates remain.</div>':`
    <div class="side-list">
      ${n.rankedCandidates.map((e,t)=>`
            <button
              class="word-pill ranked-word-pill ${t===0?"top-ranked-word":""}"
              data-word-choice="${e.guess}"
              style="${ke(t,n.rankedCandidates.length)}"
            >
              <span class="candidate-rank">${t+1}</span>
              <span class="candidate-word">${e.guess.toUpperCase()}</span>
            </button>
          `).join("")}
    </div>
  `:'<div class="empty">Press Calculate Guesses after entering your known rows.</div>'}function ve(){return n.hasCalculated?n.recommendations.length===0?'<div class="empty">No useful guesses found.</div>':`
    <div class="best-table-wrap">
      <table class="best-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Guess</th>
            <th>Type</th>
            <th>Worst</th>
            <th>Exp</th>
            <th>Info</th>
            <th>Bucket</th>
          </tr>
        </thead>

        <tbody>
          ${n.recommendations.map((e,t)=>`
                <tr
                  class="${t===0?"recommended-row":""}"
                  data-word-choice="${e.guess}"
                >
                  <td>${t===0?"★":t+1}</td>
                  <td class="best-word-cell">
                    <span class="best-word">${e.guess.toUpperCase()}</span>
                    ${t===0?'<span class="recommended-badge">Recommended</span>':""}
                  </td>
                  <td>${e.possibleAnswer?"Ans":"Probe"}</td>
                  <td>${e.worstTurns.toFixed(e.exact?0:1)}</td>
                  <td>${e.expectedTurns.toFixed(2)}</td>
                  <td>${e.entropy.toFixed(2)}</td>
                  <td>${e.worstBucket}</td>
                </tr>
              `).join("")}
        </tbody>
      </table>
    </div>
  `:'<div class="empty">No calculation yet.</div>'}function ye(){return`
    <div class="bottom-actions">
      <button class="bottom-action-key reset-key" id="reset-game-button">
        Reset Game
      </button>

      <button
        class="bottom-action-key calculate-key"
        id="calculate-button"
        ${n.loading||n.calculating?"disabled":""}
      >
        ${n.calculating?"Calculating...":"Calculate Guesses"}
      </button>
    </div>
  `}function Ce(){return`
    <div class="controls-shell">
      <button class="controls-bubble" id="controls-bubble" title="Controls">
        ⚙
      </button>

      ${n.controlsOpen?`
        <div class="controls-popover">
          <div class="controls-head">
            <strong>Controls</strong>
            <button class="icon-button" id="close-controls-button">×</button>
          </div>

          <div class="control-hint-grid">
            <div><span class="sample-dot present-dot"></span> Click selected tile</div>
            <div>Cycle forward</div>

            <div><span class="sample-dot absent-dot"></span> Right click selected tile</div>
            <div>Cycle backward</div>

            <div><span class="sample-dot correct-dot"></span> Scroll tile</div>
            <div>Cycle state</div>

            <div><span class="sample-dot unknown-dot"></span> Backspace/Delete</div>
            <div>Clear letter + lock</div>

            <div><span class="sample-dot unknown-dot"></span> Enter</div>
            <div>Calculate guesses</div>
          </div>

          <div class="mode-description">
            Uses one GTO-style ranking: minimize worst-case turns, then expected turns,
            then worst bucket, expected remaining candidates, entropy, singleton splits,
            and answer-word preference.
          </div>

          <div class="fixed-top-note">
            Guess pool: solution words only. Shows at most ${G} useful guesses.
          </div>

          <div class="popover-buttons">
            <button class="secondary-button" id="clear-current-button">Clear Selected Row Marks</button>
            <button class="secondary-button" id="undo-button">Clear Last Filled Row</button>
            <button class="danger-button" id="clear-all-button">Reset Game</button>
          </div>
        </div>
      `:""}
    </div>
  `}function u(){ne.innerHTML=`
    <main class="app-shell">
      <h1 class="app-title">Wordle Solver</h1>

      <section class="solver-layout">
        <aside class="side-panel left-side">
          <div class="side-header">
            <h2>Remaining</h2>
            <span>${n.hasCalculated?n.candidates.length:"—"}</span>
          </div>
          ${be()}
        </aside>

        <section class="center-game">
          ${n.loading?'<div class="status-line">Loading solution list...</div>':""}
          ${n.error?`<div class="status-line error">${N(n.error)}</div>`:""}
          ${ge()}
          ${me()}
          ${we()}
          ${ye()}
        </section>

        <aside class="side-panel right-side">
          <div class="side-header">
            <h2>Best Guesses</h2>
            <span>GTO</span>
          </div>
          ${ve()}
        </aside>
      </section>

      ${Ce()}
    </main>
  `,$e()}function $e(){var e,t,s,r,o,l,d;document.querySelectorAll("[data-cell-row][data-cell-col]").forEach(a=>{const c=Number(a.dataset.cellRow),i=Number(a.dataset.cellCol);a.addEventListener("click",f=>{f.preventDefault();const h=n.selectedRow===c&&n.selectedCol===i;v(c,i);const g=y(c,i);h&&g.letter?E(c,i,1):u()}),a.addEventListener("contextmenu",f=>{f.preventDefault();const h=n.selectedRow===c&&n.selectedCol===i;v(c,i);const g=y(c,i);h&&g.letter?E(c,i,-1):u()}),a.addEventListener("wheel",f=>{f.preventDefault(),v(c,i),y(c,i).letter?E(c,i,f.deltaY>0?1:-1):u()})}),document.querySelectorAll("[data-key]").forEach(a=>{a.addEventListener("click",()=>{const c=a.dataset.key;c&&de(c)})}),document.querySelectorAll("[data-word-choice]").forEach(a=>{a.addEventListener("click",()=>{const c=a.dataset.wordChoice;c&&ie(c)})}),(e=document.querySelector("#calculate-button"))==null||e.addEventListener("click",L),(t=document.querySelector("#reset-game-button"))==null||t.addEventListener("click",A),(s=document.querySelector("#controls-bubble"))==null||s.addEventListener("click",()=>{n.controlsOpen=!n.controlsOpen,u()}),(r=document.querySelector("#close-controls-button"))==null||r.addEventListener("click",()=>{n.controlsOpen=!1,u()}),(o=document.querySelector("#clear-current-button"))==null||o.addEventListener("click",ae),(l=document.querySelector("#clear-all-button"))==null||l.addEventListener("click",A),(d=document.querySelector("#undo-button"))==null||d.addEventListener("click",ue)}document.addEventListener("keydown",e=>{const t=e.target;if(!(t instanceof HTMLInputElement||t instanceof HTMLSelectElement||t instanceof HTMLTextAreaElement)){if(/^[a-zA-Z]$/.test(e.key)){j(e.key);return}if(e.key==="Backspace"||e.key==="Delete"){I();return}if(e.key==="Enter"){L();return}if(e.key==="ArrowLeft"){n.selectedCol>0?n.selectedCol--:n.selectedRow>0&&(n.selectedRow--,n.selectedCol=k-1),u();return}if(e.key==="ArrowRight"){n.selectedCol<k-1?n.selectedCol++:n.selectedRow<R-1&&(n.selectedRow++,n.selectedCol=0),u();return}if(e.key==="ArrowUp"){n.selectedRow=Math.max(0,n.selectedRow-1),u();return}e.key==="ArrowDown"&&(n.selectedRow=Math.min(R-1,n.selectedRow+1),u())}});async function Re(){u();try{const e=await D("/wordlists/valid_wordle_solutions.txt");n.solutions=e,n.candidates=[...e],n.loading=!1,u()}catch(e){n.loading=!1,n.error=e instanceof Error?e.message:String(e),u()}}Re();
