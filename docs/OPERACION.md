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
