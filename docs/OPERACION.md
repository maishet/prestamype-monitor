# Prestamype Monitor — operación

## Proyecto y rama

La carpeta oficial de trabajo es `E:\Personal proyects\prestamype-monitor` y la rama es `main`.
No se debe ejecutar `git commit`, `git push` ni trabajar desde otro checkout.

## Comandos frecuentes (PowerShell)

```powershell
Set-Location 'E:\Personal proyects\prestamype-monitor'
npm install
npm run typecheck
npm test
sam build --use-container
sam deploy --stack-name prestamype-monitor --resolve-s3 --region sa-east-1 --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset
```

## Sesión Prestamype

```powershell
npm run auth:capture
```

Iniciar sesión manualmente, aceptar/seleccionar cookies y llegar a `/app/inversionista/oportunidades`.
La sesión se guarda cifrada en Parameter Store; nunca guardar credenciales en el repositorio.

## Monitor y escaneo

```powershell
.\scripts\activate-monitor.ps1
.\scripts\invoke-once.ps1
.\scripts\status-monitor.ps1
```

`invoke-once` solo encola un escaneo y no activa el monitor. El monitor usa los riesgos y monedas persistidos en DynamoDB; `evaluated` es la cantidad de oportunidades que pasan esos filtros y llegan a evaluación.

## Telegram

```powershell
npm run telegram:test
npm run telegram:list-chats
```

El bot debe tener permiso para enviar mensajes en el grupo. Se admiten destino privado y grupo.

Los comandos administrativos solo aceptan mensajes de `TELEGRAM_OWNER_ID` enviados desde su chat privado:

```text
/estado       Estado y último error registrado
/sesionestado  Comprueba si existe sesión cifrada y si requiere recaptura
/escanear     Solicita un escaneo manual (con límites de seguridad)
/pausar       Desactiva el monitor
/reanudar     Activa el monitor si no hay una pausa de seguridad
/recuperar    Retira pausas recuperables y solicita un escaneo
```

`/recuperar` sirve después de una pausa por `SessionExpiredError`,
`SessionChallengeError` o `PageStructureError`. No puede renovar una sesión
expirada ni completar MFA: en ese caso se debe ejecutar `npm run auth:capture`,
volver a iniciar sesión y después usar `/recuperar`. Las pausas de coste o
límite de solicitudes permanecen bloqueadas y requieren revisión explícita.

## Diagnóstico AWS

```powershell
aws cloudformation describe-stacks --stack-name prestamype-monitor --region sa-east-1
aws logs tail /aws/lambda/prestamype-monitor-scan --region sa-east-1 --since 10m --format short
```

Errores `PageStructureError` indican que cambió el DOM o faltan datos en la página. `ScanDeadlineError` indica que el navegador no obtuvo la tabla dentro del límite seguro.

## Flujo de validación

1. Ejecutar `npm run typecheck` y las pruebas.
2. Construir con `sam build --use-container`.
3. Desplegar a `sa-east-1`.
4. Ejecutar `invoke-once`.
5. Revisar logs buscando `Monitor scan completed` y confirmar Telegram.

### Modales consecutivos y superpuestos

El cierre también verifica si el botón tuvo efecto antes de descartar el icono como alternativa. Un clic sin excepción puede no activar el manejador del icono; la regresión de Chromium incluye un botón contenedor sin acción y un icono que sí cierra el modal.

El cierre selecciona la última capa visible y fija su identidad DOM antes de actuar. La espera comprueba ese mismo elemento: un selector dinámico de «primer modal visible» puede saltar al segundo y producir un falso `overlay.did-not-close`. Las pantallas de autenticación y consentimiento siguen requiriendo intervención.

El contenedor exterior `.generic-modal-overlay` tiene prioridad sobre cualquier
`role="dialog"` anidado: el exterior es el que recibe el clic de fondo. La
regresión también cubre un diálogo interior inerte.

Si una campaña ya clasificada como descartable ignora el clic de fondo, el
evento directo, el botón y el icono, el monitor retira únicamente ese nodo DOM
fijado y registra `Dismissible overlay removed after inert handlers`. Esta
salida nunca se aplica a CAPTCHA, inicio de sesión ni consentimiento manual.

Después de los modales, el selector seguro «Ordenar por» y su opción usan clic
forzado porque Vue puede mantener el control visible pero inestable mientras
termina de desmontar la campaña. Esto no se aplica a filas ni a controles de
inversión.

Un ciclo no inicia otro panel de detalle si quedan menos de 30 segundos de su
presupuesto. Devuelve y persiste lo ya procesado; las filas diferidas quedan
para la siguiente ejecución automática, evitando perder todo el ciclo por
`ScanDeadlineError`.

### Evaluación progresiva

La tabla descarta primero riesgo, moneda y retorno. Una oportunidad con una
alerta registrada nunca vuelve a abrirse, aunque cambie su monto o avance; una
oportunidad nunca alertada solo se reabre si cambian sus valores visibles.

Para candidatos restantes, el navegador abre primero `Invertir`. Solo abre
`Deudor` si los historiales desconocidos todavía podrían elevar el score hasta
`REVIEW`, y solo abre `Proveedor` si después de leer Deudor aún podría cambiar
la decisión. Los límites usan máximos conservadores para no descartar una
oportunidad potencialmente alertable.

El evento `Opportunities scanned` publica:

- `investTabs`: paneles cuya pestaña Invertir fue analizada.
- `debtorTabs`: pestañas Deudor realmente consultadas.
- `supplierTabs`: pestañas Proveedor realmente consultadas.
- `detailed`: oportunidades devueltas para evaluación; no equivale a alertas.

`alertsSent` continúa siendo el único contador de mensajes enviados.

Regresión local con Chromium: `npm exec vitest -- run tests/browser/modal-regression.test.ts`. Cubre campañas superpuestas, consecutivas, botón contenedor inerte y diálogo anidado. Tras desplegar, comprobar varios ciclos automáticos completos; una invocación `START` aislada no acredita un escaneo. Si hay pausa manual, los ciclos pueden terminar sin abrir el navegador.
