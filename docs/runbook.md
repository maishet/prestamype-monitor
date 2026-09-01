# Runbook del monitor Prestamype en AWS

Este sistema **solo observa y notifica** oportunidades. No pulsa botones de inversión, no transfiere dinero y no debe modificarse para invertir automáticamente.

## Preparación de la cuenta

1. Usa una cuenta AWS propia con MFA y una identidad operadora de privilegios mínimos; no uses claves del usuario raíz.
2. Configura AWS CLI y SAM CLI, autentícate manualmente y confirma la identidad con `aws sts get-caller-identity`. No guardes claves en este repositorio.
3. Trabaja en `sa-east-1`. Crea en AWS Budgets una alerta mensual con correo verificado y umbrales conservadores; una alerta informa, no corta gasto automáticamente.
4. Ejecuta `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `sam validate --lint` y `sam build --use-container`.

## Despliegue inicialmente deshabilitado

Revisa `template.yaml` y `samconfig.toml.example`, copia la configuración a un archivo local no versionado y ejecuta `sam deploy --guided`. Conserva los nombres predeterminados de los parámetros SSM salvo que exista una convención aprobada. El despliegue no activa el monitor: no ejecutes el script de activación durante la validación inicial.

Obtén únicamente los outputs no secretos mediante CloudFormation: `FunctionName`, `TableName`, `QueueUrl` y `Region`. Nunca pegues tokens, claves, cookies, registros de sesión ni respuestas SSM en tickets, terminal compartida o logs.

## Secretos y blacklist inicial

Valida sin efectos con:

```powershell
./scripts/bootstrap-parameters.ps1 -ValidateOnly
./scripts/seed-blacklist.ps1 -ValidateOnly
```

Después ejecuta `./scripts/bootstrap-parameters.ps1`. Antes de solicitar secretos, crea o repara la configuracion completa `CONFIG/MONITOR` y fuerza `enabled=false`, preservando una configuracion existente que sea valida. Luego solicita token y chat de Telegram con entrada segura, genera localmente una clave criptografica de 32 bytes y sobrescribe deliberadamente los tres `SecureString`; los valores no se imprimen ni se escriben en archivos temporales. Si una escritura SSM falla, pueden quedar parametros mezclados entre la version anterior y la nueva, pero el monitor permanece deshabilitado: corrige el acceso, vuelve a ejecutar el bootstrap completo y no actives hasta que termine correctamente. Ejecuta `./scripts/seed-blacklist.ps1`: es idempotente, usa escrituras condicionales y nunca elimina ni reemplaza entradas existentes.

## Sesión autenticada

La autenticación es manual. Configura localmente `PRESTAMYPE_CAPTURE_ADAPTER` con el adaptador autorizado y ejecuta `npm run auth:capture`. Completa el login en el navegador visible. El adaptador debe cifrar el estado con la clave de sesión recuperada de SSM y guardarlo como `PK=SESSION`, `SK=PRESTAMYPE` en DynamoDB; no exportes cookies a archivos, argumentos o stdout. Si vence la sesión, desactiva el monitor, vuelve a capturarla manualmente y realiza un escaneo único antes de reactivar.

## Pruebas y operación

Comprueba primero el bot con un mensaje de Telegram manual que no incluya datos sensibles. Luego valida y ejecuta un solo ciclo, que no habilita encadenamiento:

```powershell
./scripts/invoke-once.ps1 -ValidateOnly
./scripts/invoke-once.ps1
```

Revisa CloudWatch y Telegram. Para operación continua:

```powershell
./scripts/activate-monitor.ps1 -ValidateOnly
./scripts/activate-monitor.ps1
```

La activación exige escribir exactamente `ACTIVAR`, persiste `enabled=true` y solo entonces programa el primer mensaje con 75–105 segundos de demora. Si falla ese envío, intenta revertir a deshabilitado. Para detener nuevos encadenamientos inmediatamente sin borrar estado:

```powershell
./scripts/deactivate-monitor.ps1
```

Puede quedar un mensaje ya en vuelo; confirma que no aparecen nuevos ciclos tras el visibility timeout.

## Diagnóstico, privacidad y costes

- Consulta logs de las funciones scan y supervisor, la edad/cantidad de mensajes SQS, la DLQ, throttles/errores Lambda, capacidad consumida DynamoDB y gasto/Budget. La supervisión corre cada diez minutos y solo recupera ciclos atrasados de forma idempotente.
- `COST_PAUSE` requiere revisión del consumo mensual antes de reactivar. También pausa ante sesión vencida, CAPTCHA, rate limit o cambios de DOM que necesiten intervención. No fuerces reintentos ante CAPTCHA o rate limit.
- Los logs deben contener categorías y correlaciones sanitizadas, nunca token, chat ID, clave, cookies, cabeceras, HTML privado, errores crudos ni registros completos de DynamoDB. Retención prevista: siete días.
- Revisa al menos semanalmente invocaciones, GB-segundos, solicitudes SQS/DynamoDB/SSM, logs ingeridos y presupuesto. Desactiva ante cualquier anomalía o correo de coste.

## Rollback

1. Ejecuta `./scripts/deactivate-monitor.ps1`.
2. Corrige o vuelve a desplegar una versión conocida mediante SAM/CloudFormation con revisión del changeset.
3. Realiza un escaneo único y revisa logs sanitizados.
4. Reactiva únicamente con autenticación vigente, coste normal y confirmación humana.

## Desmontaje completo

Desactiva primero y exporta solo los datos no sensibles que deban conservarse. Elimina el stack con SAM/CloudFormation y verifica manualmente que no queden: funciones Lambda y versiones/aliases, roles y políticas IAM, event source mapping SQS, regla/EventBridge Scheduler y permisos, cola de escaneo y DLQ (incluidos mensajes), tabla DynamoDB, GSI, backups/PITR/exportaciones si se habilitaron, grupos y streams CloudWatch Logs, alarmas y métricas/filtros personalizados, parámetros SSM de token/chat/clave y cualquier versión, artefactos SAM en S3/ECR, stack y changesets de CloudFormation. Elimina aparte el AWS Budget y sus suscripciones de correo si ya no se necesitan. Revoca credenciales locales y sesiones temporales, borra capturas locales no versionadas y confirma con inventario/tagging y facturación de los días siguientes que no quedan recursos con coste.

Los parámetros SSM y cualquier backup pueden sobrevivir si fueron creados fuera del stack: su borrado es destructivo y debe confirmarse por nombre exacto. Nunca uses comodines para el teardown.
