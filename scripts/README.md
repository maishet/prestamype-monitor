# Scripts del proyecto

Esta carpeta reúne comandos de operación del monitor y utilidades para Telegram, pruebas de build y fixtures. Ejecuta los ejemplos desde la raíz del repositorio en PowerShell, salvo que se indique `node` o `npm`.

```powershell
Set-Location 'E:\Personal proyects\prestamype-monitor'
```

Los scripts que consultan o modifican AWS usan por defecto el stack `prestamype-monitor` y la región `sa-east-1`. Debes iniciar sesión con AWS CLI en la cuenta correcta y tener permisos IAM para la operación solicitada. No pegues tokens, cookies, contraseñas ni claves en comandos o archivos versionados.

## Configuración en caliente

`configure-monitor.ps1` modifica en DynamoDB el elemento `CONFIG/MONITOR`. Los cambios se aplican en el siguiente escaneo; no despliega código ni activa/desactiva el monitor. Cada parámetro omitido conserva su valor actual.

```powershell
# Riesgos permitidos
./scripts/configure-monitor.ps1 -AllowedRisks 'A+,A,B,C'

# Una o varias monedas (separadas por comas)
./scripts/configure-monitor.ps1 -AllowedCurrencies 'PEN,USD'

# Rentabilidad anual mínima, en porcentaje
./scripts/configure-monitor.ps1 -MinimumAnnualReturnPct 10

# Inversión mínima en soles. El parámetro recibe centavos: S/ 100 = 10000
./scripts/configure-monitor.ps1 -MinimumInvestmentCents 10000

# Se pueden cambiar varias cosas en una sola ejecución
./scripts/configure-monitor.ps1 -AllowedRisks 'A+,A,B,C' -AllowedCurrencies 'PEN,USD' -MinimumAnnualReturnPct 10 -MinimumInvestmentCents 10000
```

Valores aceptados: riesgos `A+`, `A`, `B`, `C`, `D`, `E` y `PROTEGIDA`; monedas `PEN` y `USD`; retorno entre 0 y 100; inversión mínima mayor que cero. Usa las opciones con la grafía mostrada arriba. Para cambiar stack o región, usa `-StackName` y `-Region`.

`-ValidateOnly` (o `-WhatIf`) termina sin consultar ni modificar AWS:

```powershell
./scripts/configure-monitor.ps1 -AllowedCurrencies 'PEN,USD' -ValidateOnly
```

Nota: en este script `-ValidateOnly` no comprueba contra AWS ni valida el contenido de las listas permitidas; solo evita la llamada remota. La ejecución normal sí valida los valores antes de escribir.

## Scripts PowerShell de operación

| Comando                              | Uso y efecto                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./scripts/status-monitor.ps1`       | Consulta AWS y muestra si está activado, riesgos, retorno mínimo, monedas, inversión mínima, próximo escaneo en hora de Lima y cualquier pausa. Solo lectura. Acepta `-StackName`, `-Region` y `-ValidateOnly`.                                                                                                                                                                                                                 |
| `./scripts/invoke-once.ps1`          | Invoca exactamente un escaneo directo. No activa el monitor ni altera el horario programado. Ejecuta `./scripts/invoke-once.ps1 -ValidateOnly` para no llamar AWS.                                                                                                                                                                                                                                                              |
| `./scripts/activate-monitor.ps1`     | Habilita `enabled=true` tras pedir escribir exactamente `ACTIVAR`. No encola un escaneo: los siguientes los inicia el horario de EventBridge. Úsalo solo después de comprobar sesión, filtros y ausencia de pausa. `-ValidateOnly` no invoca AWS ni pide confirmación.                                                                                                                                                          |
| `./scripts/deactivate-monitor.ps1`   | Pone `enabled=false`; no borra datos ni necesariamente detiene una invocación ya iniciada. Tiene `-ValidateOnly`.                                                                                                                                                                                                                                                                                                               |
| `./scripts/resume-monitor.ps1`       | Retira solo una pausa manual recuperable causada por `SessionExpiredError`, `SessionChallengeError` o `PageStructureError`, tras pedir `REANUDAR`. No activa el monitor, no envía mensaje y no limpia pausas de coste o rate limit. Usa `-ValidateOnly` para salir sin acceder a AWS ni pedir confirmación.                                                                                                                     |
| `./scripts/bootstrap-parameters.ps1` | Inicializa o repara `CONFIG/MONITOR` deshabilitado y solicita de forma segura token/chat de Telegram; genera y guarda una nueva clave de sesión en SSM. En ejecución normal modifica AWS y sobrescribe esos secretos. `-ValidateOnly` no los solicita ni los escribe. Reserva para configuración inicial o recuperación controlada: después de generar una clave nueva, vuelve a capturar la sesión con `npm run auth:capture`. |
| `./scripts/seed-blacklist.ps1`       | Inserta/verifica las entradas iniciales de blacklist de forma idempotente; no sobrescribe ni elimina las existentes. `-ValidateOnly` evita la llamada a AWS.                                                                                                                                                                                                                                                                    |

Todos los scripts PowerShell de esta sección aceptan `-StackName` y `-Region` cuando corresponde; valores predeterminados: `prestamype-monitor` y `sa-east-1`.

### Flujo habitual

```powershell
# Inspeccionar antes de actuar
./scripts/status-monitor.ps1

# Solicitar un escaneo aislado sin habilitar ejecución periódica
./scripts/invoke-once.ps1

# Activar el horario continuo (requiere confirmación interactiva)
./scripts/activate-monitor.ps1

# Detener futuros escaneos
./scripts/deactivate-monitor.ps1
```

Para una pausa recuperable, primero corrige su causa (por ejemplo, recaptura la sesión o despliega el arreglo de DOM), luego usa `resume-monitor.ps1`; si quieres operación continua, habilita con `activate-monitor.ps1` por separado. `resume-monitor` conserva el valor actual de `enabled`.

## Telegram

### Probar el envío

```powershell
npm run telegram:test
```

Lee el token y los destinos desde Parameter Store (`/prestamype/prod/telegram-token` y `/prestamype/prod/telegram-chat-id` por defecto) y envía un mensaje real de prueba a cada chat indicado. Si hay más de un destino, sepáralos por comas en el parámetro SSM de chat. Requiere AWS CLI/credenciales con permiso de lectura de esos secretos y salida a Telegram. Opcionalmente, las variables `AWS_REGION`, `TELEGRAM_TOKEN_PARAMETER`, `TELEGRAM_CHAT_ID_PARAMETER` y `TELEGRAM_TEST_MESSAGE` permiten personalizar región, rutas y texto; no pongas secretos en `TELEGRAM_TEST_MESSAGE`.

### Listar chats vistos por el bot

```powershell
npm run telegram:list-chats
```

Consulta `getUpdates` y lista IDs/tipos/títulos de chats presentes en actualizaciones recientes. Envía primero `/start` al bot en privado o en el grupo. Este método no funciona mientras Telegram tenga registrado el webhook del monitor; no retires el webhook en producción para listar chats. Región y ruta del token se pueden ajustar con `AWS_REGION` y `TELEGRAM_TOKEN_PARAMETER`.

### Preparar o registrar el webhook

```powershell
# Antes del despliegue: crea el secreto del webhook si todavía no existe
node scripts/setup-telegram-webhook.mjs --prepare

# Después de desplegar la función de comandos: registra el webhook y menús
node scripts/setup-telegram-webhook.mjs
```

Usa el perfil AWS `prestamype` por defecto; se puede seleccionar otro con `AWS_PROFILE`. `--prepare` no registra el webhook: solo asegura el secreto y verifica el bot. Sin `--prepare`, el script comprueba que el webhook previo esté vacío o apunte al mismo endpoint, publica los menús y configura el webhook. No reemplaza un webhook ajeno. El propietario configurado en el script es quien recibe el conjunto de comandos administrativos. No ejecutes scripts basados en `getUpdates` mientras el webhook esté activo.

## Build y fixtures locales

```powershell
# Smoke test del empaquetado/runtime de Lambda; crea y elimina artefactos temporales
node scripts/smoke-sam-build.mjs

# Imprime el resultado como JSON
node scripts/smoke-sam-build.mjs --json

# Alternativa equivalente desde npm
npm run build:fixtures
```

`smoke-sam-build.mjs` requiere dependencias instaladas y verifica el bundle, la capa y la carga de Chromium sin desplegar. `build-fixtures.mjs` lee capturas HTML locales desde `captures/`, elimina ciertos elementos de seguimiento/ruido y escribe fixtures reducidos en `tests/fixtures/live/`. Las capturas originales pueden contener datos personales: revísalas y sanitízalas antes de guardarlas; no compartas ni subas capturas con datos privados.

## Comandos npm relacionados

No todos los comandos que forman parte del flujo están implementados en esta carpeta, pero se usan junto a ella:

| Comando                        | Propósito                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run auth:capture`         | Abre Chromium visible para iniciar sesión manualmente en Prestamype y guardar la sesión cifrada. No habilita el monitor. Requiere `TABLE_NAME`, `SESSION_KEY_PARAMETER` y permisos AWS correspondientes. |
| `npm run dry-run -- --fixture` | Evalúa fixtures locales sin acceso a red ni AWS.                                                                                                                                                         |
| `npm run dry-run -- --live`    | Consulta con sesión real en modo prospectivo; requiere adaptador aprobado y no envía ni reclama alertas.                                                                                                 |
| `npm test`                     | Ejecuta pruebas.                                                                                                                                                                                         |
| `npm run typecheck`            | Revisa tipos TypeScript.                                                                                                                                                                                 |
| `npm run lint`                 | Ejecuta ESLint.                                                                                                                                                                                          |
| `npm run format:check`         | Comprueba formato Prettier.                                                                                                                                                                              |
| `sam build --use-container`    | Construye el artefacto de despliegue local.                                                                                                                                                              |

Consulta [`../docs/OPERACION.md`](../docs/OPERACION.md) para operación diaria y [`../docs/runbook.md`](../docs/runbook.md) para setup, despliegue, pausa, recuperación, seguridad y diagnóstico completos.
