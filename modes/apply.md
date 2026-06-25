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

**Clasificar cada pregunta por TIPO** — el tipo decide la receta de drafting (Paso 5):

| Tipo de pregunta | Señal | Fuente principal |
|------------------|-------|------------------|
| **Behavioral / "Tell me about a time…"** | "describe a time", "give an example", "how did you handle…" | Story bank (historia STAR+R cuyo theme matchea) |
| **Motivation / "Why us / why this role"** | "why do you want", "what attracts you", "why {company}" | Exit narrative (`user/_profile.md`) + 1 hecho concreto del JD/empresa |
| **Fit / "Why are you a good fit"** | "what makes you qualified", "your strengths for this" | Dimensional table del report (Skills Match + Strategic Fit) + 1 proof point |
| **Cover letter / texto largo libre** | campo grande, "cover letter", "anything else" | Estructura de carta (Paso 5C) — combina narrative + 1-2 stories + cierre |
| **Logística** | work auth, relocation, notice period, salary | `user/profile.yml` + `user/_profile.md` (comp targets, location policy, right-to-work) — responder factual, sin fluff |

Para cada pregunta behavioral/fit, hacer **match por themes**: tomar las palabras clave de la pregunta y buscar la historia del banco cuya línea `**Themes:**` (o título/cuerpo) las cubre mejor. Una sola historia fuerte > tres historias tibias. Si **ninguna** historia matchea bien, marcarlo como gap (Paso 5D) — no fabriques una historia nueva sobre la marcha para un formulario en vivo.

## Paso 5 — Generar respuestas (la artesanía de conversión)

El objetivo no es "responder la pregunta": es producir texto que un reclutador con 200 aplicaciones leería completo y recordaría. Genérico = descartado. Estas recetas convierten material que YA existe (CV + story bank + report) en respuestas específicas, no en plantillas rellenadas.

### 5A — Receta: pregunta behavioral → respuesta desde una historia STAR+R

1. **Selecciona la historia** por theme-match (arriba). Cita su título-handle internamente para no perderla.
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
- **No re-uses el mismo proof point dos veces** en el mismo formulario salvo que sea inevitable; un formulario que repite el capstone en cada respuesta lee como un perfil de una nota.
- **Idioma:** responde en el idioma del formulario/JD (EN por defecto).

### 5E — Longitudes objetivo

| Campo | Longitud |
|-------|----------|
| Respuesta corta / dropdown justification | 1-2 frases |
| "Why this role" típico | 3-5 frases |
| Behavioral STAR+R en formulario | 4-7 frases (Situation breve, Action+Result el peso) |
| Cover letter / texto largo | 250-350 palabras (estructura 5C) |
| Campo con límite de caracteres | respeta el límite VISIBLE; prioriza Result+Action |

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
- [Cualquier observación sobre el rol, cambios, etc.]
- [Sugerencias de personalización que el candidato debería revisar]
```

## Paso 6 — Post-apply (opcional)

Si el candidato confirma que envió la aplicación:
1. Actualizar estado en `applications.md` de "Evaluated" a "Applied"
2. Actualizar `interview-prep/{Company} - {Role}.md` con las respuestas finales (append a una sección `## Final form answers`)
3. Sugerir siguiente paso: `/career-ops contacto` para LinkedIn outreach

## Scroll handling

Si el formulario tiene más preguntas que las visibles:
- Pedir al candidato que haga scroll y comparta otro screenshot
- O que pegue las preguntas restantes
- Procesar en iteraciones hasta cubrir todo el formulario
