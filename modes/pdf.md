# Modo: pdf — Generación de PDF ATS-Optimizado

> **Autonomous-mode contract.** When this mode is spawned non-interactively — `claude -p`, the starpath frontend's `shell:spawn` (e.g., the Database popover's "Tailor CV" button), a batch worker, or any context where no human is in the loop to reply — follow these rules. (For interactive `claude` runs from a terminal, ask normally.)
>
> - **Don't ask the user any questions.** Not "want me to continue?", not "should I also do X?", not "want me to run the update next?". Make the call yourself or fall through to a sensible default.
> - **Don't propose follow-up actions** at the end. Print a one-line completion summary (rows added, files written, exit code) and stop.
> - **Don't run side-checks** like update polls, "first message of session" hooks, or unrelated diagnostics — they prompt for a reply nobody can give.
> - If you genuinely cannot proceed without input — corrupted file, missing config, ambiguous instruction — write the blocker to stderr and exit non-zero so the spawn surfaces as a failed task. Don't loiter waiting.

## Pipeline completo

1. Lee `user/cv.md` y (si existe) `user/article-digest.md` como fuentes de verdad del candidato.
2. Pide al usuario el JD si no está en contexto (texto o URL).
3. **Extrae y rankea las keywords del JD** — guarda el texto del JD en `/tmp/jd-{company}.txt` y ejecuta:
   ```bash
   node scripts/ats-coverage.mjs --jd /tmp/jd-{company}.txt --cv user/cv.md --json
   ```
   Trabaja con el array `keywords[]` completo (no solo los `missing[]`): incluye `term`, `count` y `type`. Ordénalos internamente por relevancia ponderada: phrases > bigrams > unigrams con mayor `count`. Estos son los términos que guiarán todo el proceso de tailoring.
4. Detecta idioma del JD → idioma del CV (EN default).
5. Detecta ubicación empresa → formato papel:
   - US/Canada → `letter`
   - Resto del mundo → `a4`
6. Detecta arquetipo del rol → adapta framing.
7. **Genera contenido personalizado (pasos 7a–7e antes de escribir HTML):**

   **7a. Professional Summary** — escribe 3-4 líneas que:
   - Abre con la narrativa de transición/posicionamiento del candidato desde `user/_profile.md` / `user/cv.md`. NUNCA inventes una narrativa que no esté en esos archivos.
   - Inyecta los top 4-5 keywords del JD (priorizando phrases y bigrams de mayor `count`) en las primeras dos frases.
   - Cierra con una frase de framing específica al domain del JD.
   - El Summary es la sección de mayor densidad de keywords; cada frase debe servir de ancla para al menos un término clave.

   **7b. Core Competencies** — selecciona 6-8 keyword phrases para el grid:
   - Elige las phrases y bigrams de mayor `count` del JD que el candidato genuinamente posee.
   - Completa con unigrams técnicos de alta frecuencia si el candidato tiene esa skill.
   - Descarta cualquier término que el candidato NO tenga — el grid debe ser verificable.
   - Formato: `<span class="competency-tag">keyword</span>` × 6-8.

   **7c. Selección y reordenación de proyectos** — para escoger los top 3-4:
   - Puntúa cada proyecto de `user/cv.md` (y pruebas en `user/article-digest.md` si existe) contra el set de keywords del JD: +2 por phrase/bigram match, +1 por unigram match.
   - Selecciona los 3-4 con mayor score.
   - Dentro de cada proyecto, reordena bullets poniendo primero los que más keywords del JD contienen.
   - Reformula los bullets de los proyectos seleccionados con el vocabulario exacto del JD (ver § "Estrategia de keyword injection").

   **7d. Reordenación de bullets de experiencia** — para cada rol laboral:
   - Calcula un score de relevancia para cada bullet: count de keywords del JD que aparecen (stem-lite).
   - Reordena bullets de mayor a menor score dentro del mismo rol.
   - El primer bullet de cada rol es el más expuesto al ATS y al recruiter scan — debe cubrir la keyword de mayor peso (`count` × type-factor) que ese rol pueda justificar.
   - Reformula bullets usando vocabulario exacto del JD (§ "Estrategia de keyword injection"). Consulta `user/article-digest.md` para proof-points más específicos.

   **7e. Skills section** — extrae todos los skills técnicos y de idioma del candidato desde `user/cv.md`. No los inventes, no los amplifiques.

8. Construye el HTML completo desde `templates/cv-template.html` + el contenido de 7a–7e.
9. Lee `name` de `user/profile.yml` → normaliza a kebab-case lowercase → `{candidate}`. Escribe el HTML a `/tmp/cv-{candidate}-{company}.html`.

10. **Mide la cobertura ATS y cierra gaps (loop hasta convergencia):**

    ```bash
    node scripts/ats-coverage.mjs --jd /tmp/jd-{company}.txt --cv /tmp/cv-{candidate}-{company}.html --json
    ```

    **Proceso de gap-closing estructurado:**

    Para cada keyword en `missing[]`, decide en orden:

    a. **¿El candidato tiene experiencia real con este término?** Compruébalo en `user/cv.md` + `user/article-digest.md`.
       - **Sí** → reformula el logro más relevante usando el vocabulario exacto del JD (§ "Estrategia de keyword injection"). Prioriza: Summary primero si el término es de alta frecuencia (`count ≥ 3`), primer bullet del rol más relevante segundo, Skills section para términos técnicos discretos.
       - **No** → marca como "genuinamente ajeno al perfil". No toques nada. Si hay 3+ términos core genuinamente ajenos, ese es el síntoma de un fit bajo, no de un CV mal escrito.

    b. **¿Está ya cubierto por un sinónimo pero no en la forma exacta del JD?** (e.g., el CV dice "retrieval-augmented generation" pero el JD dice "RAG") → reformula para incluir AMBAS formas si caben naturalmente.

    c. **¿Es un bigram cuyas palabras ya aparecen por separado?** (e.g., JD "stakeholder management", CV ya tiene "stakeholder" y "management") — el ATS suele reconocerlo, pero si `count ≥ 2` en el JD, inyecta la phrase completa en Summary o un bullet.

    Vuelve a medir tras cada ronda de reformulaciones. **Para cuando:**
    - `coveragePct ≥ 75` → strong, procede.
    - `coveragePct` no sube entre iteraciones → has reformulado todo lo que puedes sin inventar; procede con la cobertura actual y reporta las keywords sin cubrir como "fuera del perfil".
    - `coveragePct ≥ 55` con todos los restantes marcados "genuinamente ajenos" → aceptable; procede.
    - `coveragePct < 55` con múltiples keywords core sin cubrir → señal de fit bajo; repórtalo en el output final.

11. Ejecuta: `node scripts/generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf --format={letter|a4}`

12. **Persiste la cobertura medida en un sidecar** — escribe el JSON de la última medición del paso 10 a un fichero `.ats.json` con el MISMO stem que el PDF (extensión cambiada), junto al CV en `output/`:

    ```bash
    node scripts/ats-coverage.mjs --jd /tmp/jd-{company}.txt --cv /tmp/cv-{candidate}-{company}.html --json \
      > output/cv-{candidate}-{company}-{YYYY-MM-DD}.ats.json
    ```

    Esto deja la cobertura ATS que *ya mediste* en disco, junto al CV — el JD temporal se borra y la medición se perdería si no. `apply-kit` (`scripts/apply-kit.mjs`) lee ese sidecar para decidir si el CV está "tailored" de verdad o solo "existe": sin sidecar, un CV cuenta como ATS-no-verificado (readiness "stale" → re-tailor), no como listo. El JSON debe contener al menos `coveragePct` (0–100) — es lo que el sidecar parsea; los demás campos del `--json` (missing/covered/keywords) son opcionales y útiles para una re-pasada. El nombre del sidecar lo deriva `atsSidecarName()` en `scripts/lib/apply-kit-core.mjs` cambiando la extensión final del CV por `.ats.json`, así que el PDF y su gemelo HTML comparten un único sidecar.

13. Reporta: ruta del PDF, nº páginas, **% cobertura ATS medida** (del paso 10, no estimada), keywords cubiertas vs. sin cubrir, y si las keywords sin cubrir son "fuera del perfil" o "cierre pendiente".

## Reglas ATS (parseo limpio)

- Layout single-column (sin sidebars, sin columnas paralelas)
- Headers estándar: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects"
- Sin texto en imágenes/SVGs
- Sin info crítica en headers/footers del PDF (ATS los ignora)
- UTF-8, texto seleccionable (no rasterizado)
- Sin tablas anidadas
- Keywords del JD distribuidas por sección: Summary (top 4-5 keywords, mayor densidad), primer bullet de cada rol (1-2 keywords core), Core Competencies grid (6-8 phrases/bigrams), Skills section (términos técnicos discretos)

## Diseño del PDF

- **Fonts**: Space Grotesk (headings, 600-700) + DM Sans (body, 400-500)
- **Fonts self-hosted**: `fonts/`
- **Header**: nombre en Space Grotesk 24px bold + línea gradiente `linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%))` 2px + fila de contacto
- **Section headers**: Space Grotesk 13px, uppercase, letter-spacing 0.05em, color cyan primary
- **Body**: DM Sans 11px, line-height 1.5
- **Company names**: color accent purple `hsl(270,70%,45%)`
- **Márgenes**: 0.6in
- **Background**: blanco puro

## Orden de secciones (optimizado "6-second recruiter scan")

1. Header (nombre grande, gradiente, contacto, link portfolio)
2. Professional Summary (3-4 líneas, keyword-dense)
3. Core Competencies (6-8 keyword phrases en flex-grid)
4. Work Experience (cronológico inverso)
5. Projects (top 3-4 más relevantes)
6. Education & Certifications
7. Skills (idiomas + técnicos)

## Estrategia de keyword injection (ético, basado en verdad)

**Principio:** reformula experiencia REAL con el vocabulario EXACTO del JD. La misma tarea descrita con el término que el ATS y el recruiter esperan ver. NUNCA añadir skills que el candidato no tiene.

**Dónde inyectar según el tipo de keyword:**

| Tipo | Dónde inyectar primero |
|------|------------------------|
| Phrase / bigram, `count ≥ 3` | Professional Summary (frase 1-2) |
| Phrase / bigram, `count 1-2` | Primer bullet del rol más relevante, o Core Competencies grid |
| Unigram técnico de alta frecuencia | Core Competencies grid o Skills section |
| Unigram de baja frecuencia | Bullet del rol o proyecto donde aparece de forma más natural |

**Técnicas de reformulación legítimas:**

- **Vocabulario exacto:** JD dice "RAG pipelines" y CV dice "LLM workflows with retrieval" → "RAG pipeline design and LLM orchestration workflows"
- **Expansión de scope:** JD dice "MLOps" y CV dice "observability, evals, error handling" → "MLOps and observability: evals, error handling, cost monitoring"
- **Desambiguación de frase:** JD dice "stakeholder management" y CV dice "collaborated with team" → "stakeholder management across engineering, operations, and business"
- **Doble forma:** JD usa acrónimo y expansión (e.g., "NLP (natural language processing)") → incluir ambas formas cuando el candidato tiene la skill
- **Recombinación:** el candidato tiene la experiencia dispersa en dos bullets → consolídala en uno más denso que use la phrase del JD

**Límites duros:**
- NUNCA inventar skills, herramientas o métricas que el candidato no posee.
- NUNCA modificar cifras o resultados de logros existentes.
- NUNCA añadir keywords en secciones donde la skill no es genuinamente aplicable al candidato.
- La keyword injection NO es relleno: si no cabe naturalmente en una frase que siga siendo verdad, no va.

## Medición de cobertura ATS (`scripts/ats-coverage.mjs`)

La cobertura NO se estima a ojo — se mide en dos momentos: **antes** (baseline sobre `user/cv.md`) y **después** (sobre el HTML generado). La diferencia cuantifica el valor del tailoring.

```bash
# Informe legible (cobertura %, weighted %, veredicto, gap list)
node scripts/ats-coverage.mjs --jd /tmp/jd-{company}.txt --cv /tmp/cv-...html

# JSON estructurado (para razonar sobre keywords[] / missing[] / covered[])
node scripts/ats-coverage.mjs --jd /tmp/jd-{company}.txt --cv /tmp/cv-...html --json

# El JD por stdin si no quieres un fichero temporal
cat jd.txt | node scripts/ats-coverage.mjs --jd-stdin --cv /tmp/cv-...html
```

El `--cv` acepta el HTML generado (lo convierte a texto automáticamente) o `user/cv.md`. Lectura del informe:

- **`coveragePct`** — % de keywords del JD presentes en el CV. Veredicto: ≥75 % fuerte, 55–74 % aceptable, <55 % débil.
- **`weightedCoverage`** — pondera por `count` en el JD; cubrir un término que se repite mucho pesa más.
- **`missing`** — la lista accionable: keywords del JD que el CV aún no surface. Para cada una, decide si es reformulable (§ estrategia) o genuinamente ajena al perfil.
- **`keywords[]`** — el set completo (covered + missing) con `term`, `count` y `type` — úsalo para priorizar qué inyectar primero.

## Template HTML

Usar el template en `cv-template.html`. Reemplazar los placeholders `{{...}}` con contenido personalizado:

| Placeholder | Contenido |
|-------------|-----------|
| `{{LANG}}` | `en` o `es` |
| `{{PAGE_WIDTH}}` | `8.5in` (letter) o `210mm` (A4) |
| `{{NAME}}` | (from profile.yml) |
| `{{PHONE}}` | (from profile.yml — include with its separator only when `profile.yml` has a non-empty `phone` value; omit both `<span>` and `<span class="separator">` otherwise) |
| `{{EMAIL}}` | (from profile.yml) |
| `{{LINKEDIN_URL}}` | [from profile.yml] |
| `{{LINKEDIN_DISPLAY}}` | [from profile.yml] |
| `{{PORTFOLIO_URL}}` | [from profile.yml] (o /es según idioma) |
| `{{PORTFOLIO_DISPLAY}}` | [from profile.yml] (o /es según idioma) |
| `{{LOCATION}}` | [from profile.yml] |
| `{{SECTION_SUMMARY}}` | Professional Summary / Resumen Profesional |
| `{{SUMMARY_TEXT}}` | Summary personalizado con keywords |
| `{{SECTION_COMPETENCIES}}` | Core Competencies / Competencias Core |
| `{{COMPETENCIES}}` | `<span class="competency-tag">keyword</span>` × 6-8 |
| `{{SECTION_EXPERIENCE}}` | Work Experience / Experiencia Laboral |
| `{{EXPERIENCE}}` | HTML de cada trabajo con bullets reordenados por relevancia al JD |
| `{{SECTION_PROJECTS}}` | Projects / Proyectos |
| `{{PROJECTS}}` | HTML de top 3-4 proyectos seleccionados por score de relevancia |
| `{{SECTION_EDUCATION}}` | Education / Formación |
| `{{EDUCATION}}` | HTML de educación |
| `{{SECTION_CERTIFICATIONS}}` | Certifications / Certificaciones |
| `{{CERTIFICATIONS}}` | HTML de certificaciones |
| `{{SECTION_SKILLS}}` | Skills / Competencias |
| `{{SKILLS}}` | HTML de skills |

## Canva CV Generation (optional)

If `user/profile.yml` has `canva_resume_design_id` set, offer the user a choice before generating:
- **"HTML/PDF (fast, ATS-optimized)"** — existing flow above
- **"Canva CV (visual, design-preserving)"** — new flow below

If the user has no `canva_resume_design_id`, skip this prompt and use the HTML/PDF flow.

### Canva workflow

#### Step 1 — Duplicate the base design

a. `export-design` the base design (using `canva_resume_design_id`) as PDF → get download URL
b. `import-design-from-url` using that download URL → creates a new editable design (the duplicate)
c. Note the new `design_id` for the duplicate

#### Step 2 — Read the design structure

a. `get-design-content` on the new design → returns all text elements (richtexts) with their content
b. Map text elements to CV sections by content matching:
   - Look for the candidate's name → header section
   - Look for "Summary" or "Professional Summary" → summary section
   - Look for company names from cv.md → experience sections
   - Look for degree/school names → education section
   - Look for skill keywords → skills section
c. If mapping fails, show the user what was found and ask for guidance

#### Step 3 — Generate tailored content

Same content generation as the HTML flow (Steps 7a–7e above):
- Rewrite Professional Summary with JD keywords + exit narrative from `user/_profile.md`
- Reorder experience bullets by JD relevance score
- Select top competencies from JD requirements
- Inject keywords naturally (NEVER invent)

**IMPORTANT — Character budget rule:** Each replacement text MUST be approximately the same length as the original text it replaces (within ±15% character count). If tailored content is longer, condense it. The Canva design has fixed-size text boxes — longer text causes overlapping with adjacent elements. Count the characters in each original element from Step 2 and enforce this budget when generating replacements.

#### Step 4 — Apply edits

a. `start-editing-transaction` on the duplicate design
b. `perform-editing-operations` with `find_and_replace_text` for each section:
   - Replace summary text with tailored summary
   - Replace each experience bullet with reordered/rewritten bullets
   - Replace competency/skills text with JD-matched terms
   - Replace project descriptions with top relevant projects
c. **Reflow layout after text replacement:**
   After applying all text replacements, the text boxes auto-resize but neighboring elements stay in place. This causes uneven spacing between work experience sections. Fix this:
   1. Read the updated element positions and dimensions from the `perform-editing-operations` response
   2. For each work experience section (top to bottom), calculate where the bullets text box ends: `end_y = top + height`
   3. The next section's header should start at `end_y + consistent_gap` (use the original gap from the template, typically ~30px)
   4. Use `position_element` to move the next section's date, company name, role title, and bullets elements to maintain even spacing
   5. Repeat for all work experience sections
d. **Verify layout before commit:**
   - `get-design-thumbnail` with the transaction_id and page_index=1
   - Visually inspect the thumbnail for: text overlapping, uneven spacing, text cut off, text too small
   - If issues remain, adjust with `position_element`, `resize_element`, or `format_text`
   - Repeat until layout is clean
d. Show the user the final preview and ask for approval
e. `commit-editing-transaction` to save (ONLY after user approval)

#### Step 5 — Export and download PDF

a. `export-design` the duplicate as PDF (format: a4 or letter based on JD location)
b. **IMMEDIATELY** download the PDF using Bash:
   ```bash
   curl -sL -o "output/cv-{candidate}-{company}-canva-{YYYY-MM-DD}.pdf" "{download_url}"
   ```
   The export URL is a pre-signed S3 link that expires in ~2 hours. Download it right away.
c. Verify the download:
   ```bash
   file output/cv-{candidate}-{company}-canva-{YYYY-MM-DD}.pdf
   ```
   Must show "PDF document". If it shows XML or HTML, the URL expired — re-export and retry.
d. Report: PDF path, file size, Canva design URL (for manual tweaking)

#### Error handling

- If `import-design-from-url` fails → fall back to HTML/PDF pipeline with message
- If text elements can't be mapped → warn user, show what was found, ask for manual mapping
- If `find_and_replace_text` finds no matches → try broader substring matching
- Always provide the Canva design URL so the user can edit manually if auto-edit fails

## Post-generación

Actualizar tracker si la oferta ya está registrada: cambiar PDF de ❌ a ✅.
