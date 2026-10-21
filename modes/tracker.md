# Modo: tracker — Tracker de Aplicaciones

Lee y muestra `data/applications.md`.

**Formato del tracker:**
```markdown
| # | Fecha | Empresa | Rol | Score | Estado | PDF | Report |
```

Estados posibles: `Evaluada` → `Aplicado` → `Respondido` → `Contacto` → `Entrevista` → `Oferta` / `Rechazada` / `Descartada` / `NO APLICAR`

- `Aplicado` = el candidato envió su candidatura
- `Respondido` = Un recruiter/empresa contactó y el candidato respondió (inbound)
- `Contacto` = El candidato contactó proactivamente a alguien de la empresa (outbound, ej: LinkedIn power move)

Si el usuario pide actualizar un estado, editar la fila correspondiente.

Mostrar también estadísticas:
- Total de aplicaciones
- Por estado
- Match y Ease promedio (celdas Score `M8.3 E5.6`; las celdas legacy `X.X/10` se muestran tal cual y no entran en el promedio)
- % con PDF generado
- % con report generado
