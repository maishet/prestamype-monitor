[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [string]$AllowedRisks,
    [string]$AllowedCurrencies,
    [ValidateRange(0, 100)][double]$MinimumAnnualReturnPct,
    [ValidateRange(1, 9223372036854775807)][long]$MinimumInvestmentCents,
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validación local correcta; AWS no fue invocado."; return }

$updates = @{}
if ($PSBoundParameters.ContainsKey("AllowedRisks")) {
    $risks = @($AllowedRisks -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
    if ($risks.Count -eq 0 -or @($risks | Where-Object { $_ -notin @("A+", "A", "B", "C", "D", "E") }).Count -gt 0) { throw "AllowedRisks debe contener riesgos A+, A, B, C, D o E separados por comas." }
    $updates["monitor.allowedRisks"] = @{ L = @($risks | ForEach-Object { @{ S = $_ } }) }
}
if ($PSBoundParameters.ContainsKey("AllowedCurrencies")) {
    $currencies = @($AllowedCurrencies -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
    if ($currencies.Count -eq 0 -or @($currencies | Where-Object { $_ -notin @("PEN", "USD") }).Count -gt 0) { throw "AllowedCurrencies debe contener PEN o USD separados por comas." }
    $updates["monitor.allowedCurrencies"] = @{ L = @($currencies | Select-Object -Unique | ForEach-Object { @{ S = $_ } }) }
}
if ($PSBoundParameters.ContainsKey("MinimumAnnualReturnPct")) { $updates["monitor.minimumAnnualReturnPct"] = @{ N = $MinimumAnnualReturnPct.ToString([Globalization.CultureInfo]::InvariantCulture) } }
if ($PSBoundParameters.ContainsKey("MinimumInvestmentCents")) { $updates["monitor.minimumInvestmentCents"] = @{ N = $MinimumInvestmentCents.ToString() } }
if ($updates.Count -eq 0) { throw "Indica al menos un parámetro de configuración para actualizar." }

$tableName = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or $tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw "No se pudo resolver TableName de forma segura." }
$paths = @($updates.Keys | ForEach-Object { "$_ = :v$([array]::IndexOf(@($updates.Keys), $_))" })
$values = @{}
$index = 0
foreach ($key in $updates.Keys) { $values[":v$index"] = $updates[$key]; $index++ }
$tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $request = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; UpdateExpression = "SET " + ($paths -join ', '); ExpressionAttributeValues = $values; ReturnValues = "NONE" }
    [IO.File]::WriteAllText($tempPath, ($request | ConvertTo-Json -Depth 12 -Compress), (New-Object Text.UTF8Encoding($false)))
    & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $tempPath) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo actualizar la configuración." }
} finally { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } }
Write-Output "Configuración actualizada en caliente; el próximo escaneo usará los nuevos filtros."
