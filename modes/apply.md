# Modo: apply — Asistente de Aplicación en Vivo

> **Autonomous-mode contract.** When this mode is spawned non-interactively — `claude -p`, the starpath frontend's `shell:spawn` (e.g., the Database popover's "Draft Application" button), a batch worker, or any context where no human is in the loop to reply — follow these rules. (For interactive `claude` runs from a terminal where the candidate is at the keyboard, ask normally — this mode is conversational by design.)
>
> - **Don't ask the user any questions.** Not "want me to continue?", not "should I also do X?", not "want me to run the update next?". Draft answers using everything in the report + CV + profile, write them to disk for the user to review later, and finish.
> - **Don't propose follow-up actions** at the end. Print a one-line completion summary (rows added, files written, exit code) and stop.
> - **Don't run side-checks** like update polls, "first message of session" hooks, or unrelated diagnostics — they prompt for a reply nobody can give.
> - If you genuinely cannot proceed without input — corrupted file, missing config, ambiguous instruction — write the blocker to stderr and exit non-zero so the spawn surfaces as a failed task. Don't loiter waiting.

Modo interactivo para cuando el candidato está rellenando un formulario de aplicación en Chrome. Lee lo que hay en pantalla, carga el contexto previo de la oferta, y genera respuestas personalizadas para cada pregunta del formulario.

## Requisitos

- **Mejor con Playwright visible**: En modo visible, el candidato ve el navegador y Claude puede interactuar con la página.
- **Sin Playwright**: el candidato comparte un screenshot o pega las preguntas manualmente.

## Workflow

```
1. DETECTAR    → Leer Chrome tab activa (screenshot/URL/título)
2. IDENTIFICAR → Extraer empresa + rol de la página
3. BUSCAR      → Match contra reports existentes en reports/
4. CARGAR      → Leer report completo + Section G (si existe)
5. COMPARAR    → ¿El rol en pantalla coincide con el evaluado? Si cambió → avisar
6. ANALIZAR    → Identificar TODAS las preguntas del formulario visibles
7. GENERAR     → Para cada pregunta, generar respuesta personalizada
8. PRESENTAR   → Mostrar respuestas formateadas para copy-paste
```

## Paso 1 — Detectar la oferta

**Con Playwright:** Tomar snapshot de la página activa. Leer título, URL, y contenido visible.

**Sin Playwright:** Pedir al candidato que:
- Comparta un screenshot del formulario (Read tool lee imágenes)
- O pegue las preguntas del formulario como texto
- O diga empresa + rol para que lo busquemos

## Paso 2 — Identificar y buscar contexto

1. Extraer nombre de empresa y título del rol de la página
2. Buscar en `reports/` por nombre de empresa (Grep case-insensitive)
3. Si hay match → cargar el report completo
4. Si hay un `interview-prep/{Company} - {Role}.md` → cargarlo también (contexto STAR + draft answers previos)
5. Si NO hay match → avisar y ofrecer ejecutar `/career-ops scouting` para evaluar primero
6. **Leer `interview-prep/story-bank.md`** si existe — las historias STAR+R del banco son la fuente preferida para respuestas de formulario. Usar historias existentes antes de generar respuestas desde cero. El formato canónico del banco está definido en `templates/story-bank.template.md` (heading `### {Título}`, beats `**Situation/Task/Action/Result/Reflection:**`, línea `**Themes:**` de tags). Cada historia tiene un **título-handle** y **themes**; usa los themes para hacer match con cada pregunta del formulario (ver Paso 5).

## Paso 3 — Detectar cambios en el rol

Si el rol en pantalla difiere del evaluado:
- **Avisar al candidato**: "El rol ha cambiado de [X] a [Y]. ¿Quieres que re-evalúe o adapto las respuestas al nuevo título?"
- **Si adaptar**: Ajustar las respuestas al nuevo rol sin re-evaluar
- **Si re-evaluar**: Ejecutar evaluación A-F completa, actualizar report, regenerar Section G
- **Actualizar tracker**: Cambiar título del rol en applications.md si procede

## Paso 4 — Analizar preguntas del formulario

Identificar TODAS las preguntas visibles:
- Campos de texto libre (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Campos de salario (range, expectation)
- Upload fields (resume, cover letter PDF)

**Clasificar cada pregunta por TIPO antes de redactar nada.** El tipo decide la receta de drafting (Paso 5); redactar sin clasificar es como acabas con respuestas genéricas. Recorre cada pregunta por la primera fila que matchee, de arriba abajo:

| Tipo de pregunta | Señal | Fuente principal | Receta |
|------------------|-------|------------------|--------|
| **Logística** | work auth, visa, relocation, notice period, start date, salary/comp, "are you authorized…" | `user/profile.yml` (compensation, visa_status, location_flexibility, onsite_availability) + `user/_profile.md` (location policy) — factual, sin fluff | 5F |
| **Behavioral / "Tell me about a time…"** | "describe a time", "give an example", "how did you handle…", "a situation where you…" | Story bank — historia STAR+R cuya competency/theme matchea | 5A |
| **Cover letter / texto largo libre** | campo grande, "cover letter", "anything else you'd like us to know" | Estructura de carta — narrative + 1-2 stories + cierre | 5C |
| **Motivation / "Why us / why this role"** | "why do you want", "what attracts you", "why {company}", "why this team" | Exit narrative (`user/_profile.md`) + 1 hecho concreto del JD/empresa | 5B |
| **Fit / "Why are you a good fit"** | "what makes you qualified", "your strengths for this", "what would you bring" | Dimensional table del report (Skills Match + Strategic Fit) + 1 proof point | 5B |

**Reglas de clasificación:**
- **Logística primero.** Si la pregunta pide un hecho (comp, fecha, visa, autorización), es 5F aunque venga envuelta en prosa — no la conviertas en una mini-cover-letter.
- **Preguntas compuestas** (un campo que pide DOS cosas, p. ej. "why this role *and* what's your biggest strength"): respóndelas como dos movimientos dentro de la misma respuesta, no elijas una y ignores la otra. Etiqueta internamente ambos tipos y combina las recetas en orden.
- **Behavioral vs. Fit:** "tell me about a time" siempre va a una historia concreta (5A); "why are you a good fit" es una afirmación respaldada por UN proof point (5B), no una historia entera.

Para cada pregunta behavioral, hacer **match por competency primero, luego por theme/texto** — es el orden que usa el ranking del banco (`scripts/lib/story-bank.mjs`: clasifica la pregunta a una competency canónica, luego elige la historia que la cubre; el texto desempata). Las competencies canónicas (ownership, leadership, collaboration, conflict, failure, ambiguity, analytical, impact, communication, customer, learning, innovation) son el vocabulario compartido entre la pregunta y la línea `**Themes:**` de cada historia. Una sola historia fuerte > tres historias tibias. Si **ninguna** historia cubre la competency de la pregunta, marcarlo como gap (Paso 5D) — no fabriques una historia nueva sobre la marcha para un formulario en vivo.

**La clasificación de la tabla de arriba está implementada de forma determinista** en `classifyQuestion()` (`scripts/lib/apply-core.mjs`) — recorre las mismas filas en el mismo orden (logística primero), detecta campos **compuestos** (devuelve un `secondary` recipe cuando una segunda receta también dispara) y, para preguntas behavioral, infiere la competency con la MISMA taxonomía compartida (`story-bank.mjs`) que usa el ranking de historias. Úsala para fijar el tipo de cada campo antes de redactar — así la receta (5A/5B/5C/5F) y la fuente quedan determinadas por código, no por criterio variable campo a campo. Para un campo que la función marque `defaulted: true` (no matcheó ninguna señal), lee el contexto y decide tú; el default es solo un punto de partida seguro.

## Paso 5 — Generar respuestas (la artesanía de conversión)

El objetivo no es "responder la pregunta": es producir texto que un reclutador con 200 aplicaciones leería completo y recordaría. Genérico = descartado. Estas recetas convierten material que YA existe (CV + story bank + report) en respuestas específicas, no en plantillas rellenadas.

### 5A — Receta: pregunta behavioral → respuesta desde una historia STAR+R

1. **Selecciona la historia** por competency-match, luego theme/texto (arriba). Cita su título-handle internamente para no perderla.
2. **Comprime los 5 beats al largo del campo** (ver tabla de longitudes abajo). El orden de prioridad cuando hay que recortar es: **Result → Action → Situation → Task → Reflection**. El número del Result nunca se recorta; es lo que hace memorable la respuesta.
3. **Reescribe el opening para la pregunta exacta.** No pegues el Situation tal cual del banco — abre conectando con lo que la pregunta pide. Ej.: pregunta "a time you influenced without authority" + historia con theme `influence-without-authority` → abre con *"I didn't own the data team, but the dashboard nobody trusted was blocking my analysis, so…"*.
4. **Aterriza el Result con el número primero**, luego el impacto de negocio. "Adoption 20%→75% in one quarter" antes que "which made the team happier".
5. **Cierra con la Reflection SOLO si cabe** y añade algo (madurez, aprendizaje). En respuestas cortas, córtala.

**Una historia del banco se reusa en MÚLTIPLES roles** cambiando el opening y qué beat se enfatiza — no se reescribe de cero cada vez. Esa es la razón de existir del banco.

### 5B — Receta: motivation / fit → respuesta específica (no genérica)

- **"Why this role/company":** una frase de la **exit narrative** (`user/_profile.md` § Your Exit Narrative) + **un hecho concreto** del JD o de la empresa (un producto, un valor que publican, una línea del JD). Prohibido: "I'm passionate about", "your innovative culture", "a great opportunity to grow". Si no puedes nombrar algo específico de ESTA empresa, la respuesta aún no está lista.
- **"Why you're a good fit":** lidera con la dimensión más fuerte de la dimensional table (Skills Match si es alto, Strategic/Analytical Fit si el rol es analítico) y respáldala con UN proof point cuantificado del CV. Reconoce brevemente el gap más relevante de la sección Gaps del report enmarcado como trayectoria, nunca a la defensiva.
- **Tono "I'm choosing you":** postura de quien evalúa el rol, no de quien suplica. Específico, conciso, sin superlativos vacíos.

### 5C — Receta: cover letter / texto largo libre

Estructura de 4 movimientos (≈250-350 palabras salvo que el campo pida otra cosa):

1. **Gancho (1-2 frases):** la exit narrative comprimida + por qué ESTA empresa/rol es el siguiente paso natural. Nada de "I am writing to apply for…".
2. **Prueba (1 párrafo):** la historia STAR+R más relevante del banco, comprimida a 3-4 frases, liderando con el Result cuantificado. Esto es el corazón — una prueba concreta, no una lista de adjetivos.
3. **Puente (1 párrafo):** conecta tu fingerprint (la dimensión más fuerte del report + tu cross-cutting advantage de `_profile.md`) con 1-2 necesidades específicas del JD. Aquí va el segundo proof point si hay espacio.
4. **Cierre (1-2 frases):** confianza tranquila + un gesto concreto hacia adelante. Sin "I look forward to hearing from you" genérico.

### 5D — Reglas anti-genérico (aplican a TODA respuesta)

- **Cada respuesta cita ≥1 concreto:** un número, un nombre propio (proyecto/empresa/herramienta del CV), o una línea del JD. Una respuesta sin un solo concreto verificable se descarta y se reescribe.
- **Bans duros:** "passionate about", "fast-paced environment", "team player", "hit the ground running", "wear many hats", "results-driven", "think outside the box", "synergy", "I believe I would be a great fit". Si aparecen, reescribe.
- **NUNCA inventes métricas ni experiencia.** Los números salen de `user/cv.md` / `user/article-digest.md`. Si una historia del banco no tiene número, úsala pero no inventes uno — marca al usuario que ese Result debería cuantificarse.
- **Gap sin historia:** si una pregunta behavioral no tiene historia en el banco que matchee, dilo en las Notas (Paso "Notas") como `[gap: no hay historia para '{theme}' — considera añadir una desde {experiencia del CV}]`. No rellenes con una historia tibia ni fabriques una.
- **No re-uses el mismo proof point dos veces** en el mismo formulario salvo que sea inevitable; un formulario que repite el capstone en cada respuesta lee como un perfil de una nota. Esto es una propiedad del formulario ENTERO, no de una respuesta aislada — por eso `scripts/lib/apply-core.mjs` lleva un **ledger de proof points** (`createProofLedger` + `recordProofUse`): etiqueta cada respuesta con los proof points que usó (un título de historia, un handle de proyecto, una métrica) y el ledger te avisa (`reused`) cuando uno ya apareció antes. Pásalo entre respuestas; al final, `overusedProofs()` lista los que se repitieron de más.
- **Idioma:** responde en el idioma del formulario/JD (EN por defecto).

### 5E — Longitudes objetivo

| Campo | Longitud |
|-------|----------|
| Respuesta corta / dropdown justification | 1-2 frases |
| "Why this role" típico | 3-5 frases |
| Behavioral STAR+R en formulario | 4-7 frases (Situation breve, Action+Result el peso) |
| Cover letter / texto largo | 250-350 palabras (estructura 5C) |
| Campo con límite de caracteres | respeta el límite VISIBLE; prioriza Result+Action |

### 5F — Receta: logística (comp / disponibilidad / autorización)

Estos campos parecen triviales pero son donde se pierde apalancamiento. Una cifra mal puesta ancla la negociación en tu contra antes de que empiece. Lee los valores de `user/profile.yml` § `compensation` y § `location`; nunca inventes ni redondees a ojo.

- **Salario / expectativa de comp:**
  - Si el formulario pide un **rango**, da el rango objetivo (`compensation.target_range`). Si pide un **número único**, da el extremo superior del rango o un punto alto dentro de él — nunca el `minimum` (es tu walk-away, es información privada que solo destruye apalancamiento si se filtra).
  - Si el campo es **obligatorio y numérico** y no puedes dar rango, usa el techo del rango objetivo, no el suelo.
  - Si es **opcional o de texto libre**, prefiere diferir: *"Open to discussing once I understand the full scope and total package"* — pero solo si el formulario lo permite sin bloquear el envío.
  - Indica moneda y si es base o total comp cuando el campo lo permita (`compensation.currency`). No mezcles base con OTE.
- **Autorización / visa:** responde el hecho exacto de `location.visa_status` (p. ej. "authorized to work in {country} without sponsorship" / "require sponsorship"). Sin matizar ni disculparse. Si el rol está en un país donde el candidato necesita patrocinio y el formulario pregunta, di la verdad — no la ocultes.
- **Relocation / on-site:** deriva de `location.location_flexibility` + `location.onsite_availability` + la location policy de `user/_profile.md`. Si el candidato tiene una ventana de disponibilidad física concreta para una ciudad, refléjala con su fecha real leída de la fuente, no inventes.
- **Notice period / start date:** lee de `user/_profile.md` / `user/cv.md`; si no está documentado, márcalo como gap en las Notas (`[gap: notice period no documentado — confirmar]`) en vez de adivinar.
- **Tono:** factual, completo, una frase. Nada de fluff ni de venderte en un campo de logística — el reclutador filtra por hechos aquí, no por prosa.

### 5G — Self-check antes de entregar (gate obligatorio)

Antes de imprimir el output, pasa CADA respuesta por este filtro. Si alguna falla, reescríbela — no la entregues con una nota de disculpa:

1. **¿Tiene ≥1 concreto verificable?** (número del CV, nombre propio de proyecto/empresa/herramienta, o una línea del JD). Si no → reescribe.
2. **¿Contiene algún ban duro** (Paso 5D)? Si sí → reescribe.
3. **¿Está dentro del largo objetivo** (Paso 5E) y del límite de caracteres visible? Si se pasa → recorta por prioridad (Result/Action primero).
4. **¿El mismo proof point se repite** en otra respuesta del formulario? Si sí y es evitable → sustituye por otro del CV/banco.
5. **¿Las cifras salen de `user/cv.md` / `user/article-digest.md` / `user/profile.yml`** y no de tu memoria? Ninguna métrica inventada.
6. **Logística:** ¿filtraste el walk-away (`minimum`)? Nunca debe aparecer. ¿La cifra de comp es coherente con `target_range`?

**Las comprobaciones mecánicas (1–4 y 6) están implementadas y testeadas** en `selfCheck()` (`scripts/lib/apply-core.mjs`): detecta los bans duros (`scanForBannedPhrases` con la lista canónica `BANNED_PHRASES`), verifica el concreto (`hasConcrete` — número, o un token del vocabulario de pruebas del CV / del JD que tú le pasas), mide el largo contra la banda de la receta y contra el límite de caracteres visible (`lengthCheck` / `LENGTH_TARGETS`), aplica el ledger anti-reúso del Paso 5D, y respeta un flag `leakedWalkaway` para el gate de logística. Devuelve `{ ok, gates, reasons, ledger }` — si `ok` es `false`, las `reasons` te dicen exactamente qué reescribir, y `ledger` es el estado a pasar a la siguiente respuesta. Lo que la función NO juzga (y sigue siendo tuyo): si una métrica es *inventada* (gate 5 — solo tú sabes si salió de `user/cv.md`) y si el walk-away se filtró de verdad (le pasas `leakedWalkaway`). Los campos de **logística** quedan exentos de los gates de concreto y largo (un campo de salario no tiene un "concreto" que citar ni debe inflarse), pero el gate de ban duro y el de walk-away siguen aplicando.

**Formato de output:**

```
## Respuestas para [Empresa] — [Rol]

Basado en: Report #NNN | Score: X.X/10 | Arquetipo: [tipo]

---

### 1. [Pregunta exacta del formulario]
> [Respuesta lista para copy-paste]

### 2. [Siguiente pregunta]
> [Respuesta]

...

---

Notas:
- [Gaps detectados: `[gap: …]` de competencies sin historia o datos de logística sin documentar]
- [Cualquier observación sobre el rol, cambios respecto al evaluado, etc.]
- [Sugerencias de personalización que el candidato debería revisar antes de enviar]
```

Las respuestas se entregan listas para copy-paste; el candidato siempre revisa y envía (nunca auto-submit — ver `CLAUDE.md` § Ethical Use). Si el Score del report es < 7.0, recuérdalo brevemente en las Notas antes de redactar.

## Paso 6 — Post-apply (opcional)

Si el candidato confirma que envió la aplicación:
1. Actualizar estado en `applications.md` de "Evaluated" a "Applied"
2. Actualizar `interview-prep/{Company} - {Role}.md` con las respuestas finales (append a una sección `## Final form answers`)
3. **Cerrar el loop del banco:** si una respuesta behavioral salió de una historia que aún no estaba en `interview-prep/story-bank.md` (la armaste ad-hoc desde el CV), añádela ahora con el formato canónico (`### {Título}` + beats STAR+R + `**Themes:**`) para que el banco crezca. Si detectaste un `[gap: no hay historia para '{competency}']`, anótalo para que el candidato lo construya. Nunca dupliques un título existente — actualiza el que ya está (dedup por `storyTitleKey`).
4. Sugerir siguiente paso: `/career-ops contacto` para LinkedIn outreach

## Scroll handling

Si el formulario tiene más preguntas que las visibles:
- Pedir al candidato que haga scroll y comparta otro screenshot
- O que pegue las preguntas restantes
- Procesar en iteraciones hasta cubrir todo el formulario
