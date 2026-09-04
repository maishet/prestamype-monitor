[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# The EventBridge rule fires on its own cadence, so activation is only the flag.
# Nothing is enqueued here and there is nothing to roll back.
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validacion local correcta; AWS no fue invocado y no se solicito confirmacion."; return }

function Has-Property([object]$Value, [string]$Name) {
    return $null -ne $Value -and @($Value.PSObject.Properties | ForEach-Object { $_.Name }) -contains $Name
}

function Is-CompleteEnabledConfig([object]$Response) {
    try {
        if (-not (Has-Property $Response "Item")) { return $false }
        $item = $Response.Item
        if ($item.PK.S -cne "CONFIG" -or $item.SK.S -cne "MONITOR" -or $item.enabled.BOOL -ne $true) { return $false }
        $monitor = $item.monitor.M
        foreach ($name in @("allowedRisks", "minimumAnnualReturnPct", "currency", "minimumInvestmentCents", "highPriorityScore", "reviewScore", "detailRefreshIntervalMs")) {
            if (-not (Has-Property $monitor $name)) { return $false }
        }
        $risks = @($monitor.allowedRisks.L | ForEach-Object { $_.S })
        if ($risks.Count -eq 0 -or @($risks | Where-Object { $_ -notin @("A+", "A", "B", "C", "D", "E", "PROTEGIDA") }).Count -gt 0) { return $false }
        return $true
    } catch { return $false }
}

$confirmation = Read-Host "Escribe exactamente ACTIVAR para habilitar el monitor"
if ($confirmation -cne "ACTIVAR") { throw "Activacion cancelada." }

$outputsText = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs" --output json
if ($LASTEXITCODE -ne 0) { throw "No se pudieron resolver los outputs." }
$outputs = $outputsText | ConvertFrom-Json
$tableName = ($outputs | Where-Object OutputKey -eq "TableName").OutputValue
if ($tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw "Outputs del stack invalidos." }

$tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $required = "attribute_exists(PK) AND attribute_exists(monitor) AND attribute_exists(monitor.allowedRisks) AND attribute_exists(monitor.minimumAnnualReturnPct) AND attribute_exists(monitor.currency) AND attribute_exists(monitor.minimumInvestmentCents) AND attribute_exists(monitor.highPriorityScore) AND attribute_exists(monitor.reviewScore) AND attribute_exists(monitor.detailRefreshIntervalMs) AND attribute_exists(costLimits) AND attribute_exists(costLimits.configuredMemoryGb) AND attribute_exists(costLimits.monthlyGbSecondsLimit) AND attribute_not_exists(paused_until) AND enabled = :disabled"
    $request = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; UpdateExpression = "SET enabled = :enabled"; ConditionExpression = $required; ExpressionAttributeValues = @{ ":enabled" = @{ BOOL = $true }; ":disabled" = @{ BOOL = $false } } }
    [IO.File]::WriteAllText($tempPath, ($request | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $activationOutput = & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $tempPath) --output json 2>&1
        $activationExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    if ($activationExit -ne 0) {
        if (($activationOutput -join " ") -match "ConditionalCheckFailedException") {
            $readRequest = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; ConsistentRead = $true }
            [IO.File]::WriteAllText($tempPath, ($readRequest | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
            $readText = & aws dynamodb get-item --region $Region --cli-input-json ("file://" + $tempPath) --output json
            if ($LASTEXITCODE -eq 0) {
                $readResponse = $readText | ConvertFrom-Json
                if (Is-CompleteEnabledConfig $readResponse) { Write-Output "El monitor ya estaba activado."; return }
            }
            throw "No se activo: la configuracion falta, es invalida o esta pausada. Ejecute bootstrap, resume-monitor o revise el estado."
        }
        throw "No se pudo habilitar el monitor."
    }
} finally { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } }
Write-Output "Monitor activado; la regla programada ejecutara el proximo escaneo."
