[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validación local correcta; AWS no fue invocado."; return }

$tableName = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or $tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw "No se pudo resolver TableName de forma segura." }

$itemJson = & aws dynamodb get-item --table-name $tableName --key '{"PK":{"S":"CONFIG"},"SK":{"S":"MONITOR"}}' --consistent-read --region $Region --output json
if ($LASTEXITCODE -ne 0) { throw "No se pudo consultar el estado del monitor." }
$response = $itemJson | ConvertFrom-Json
if ($null -eq $response.Item) { throw "No existe la configuración CONFIG/MONITOR." }
$item = $response.Item
$enabled = $item.enabled.BOOL -eq $true
$state = if ($enabled) { "ACTIVADO" } else { "DESHABILITADO" }
Write-Output "Estado: $state"
$monitor = $item.monitor.M
if ($null -ne $monitor) {
    $risks = @($monitor.allowedRisks.L | ForEach-Object { $_.S }) -join ","
    Write-Output "Riesgos: $risks"
    Write-Output "Rentabilidad mínima (%): $($monitor.minimumAnnualReturnPct.N)"
    Write-Output "Moneda: $($monitor.currency.S)"
    if ($monitor.PSObject.Properties.Name -contains "allowedCurrencies") { Write-Output "Monedas permitidas: $((@($monitor.allowedCurrencies.L | ForEach-Object { $_.S })) -join ',')" }
    Write-Output "Inversión mínima (centavos): $($monitor.minimumInvestmentCents.N)"
}
if ($item.PSObject.Properties.Name -contains "next_scan_at") { Write-Output "Próximo escaneo (UTC): $($item.next_scan_at.S)" }
if ($item.PSObject.Properties.Name -contains "paused_until") { Write-Output "Pausado hasta (UTC): $($item.paused_until.S)" }
if ($item.PSObject.Properties.Name -contains "pause_reason") { Write-Output "Motivo de pausa: $($item.pause_reason.S)" }
