[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validacion local correcta; AWS no fue invocado y no se solicito confirmacion."; return }

function Has-Property([object]$Value, [string]$Name) {
    return $null -ne $Value -and @($Value.PSObject.Properties | ForEach-Object { $_.Name }) -contains $Name
}

function Is-CompleteDisabledConfig([object]$Item) {
    try {
        if ($Item.PK.S -cne "CONFIG" -or $Item.SK.S -cne "MONITOR" -or $Item.enabled.BOOL -ne $false) { return $false }
        $monitor = $Item.monitor.M
        $cost = $Item.costLimits.M
        foreach ($name in @("allowedRisks", "minimumAnnualReturnPct", "currency", "minimumInvestmentCents", "highPriorityScore", "reviewScore", "detailRefreshIntervalMs")) {
            if (-not (Has-Property $monitor $name)) { return $false }
        }
        foreach ($name in @("configuredMemoryGb", "monthlyGbSecondsLimit")) {
            if (-not (Has-Property $cost $name)) { return $false }
        }
        $risks = @($monitor.allowedRisks.L | ForEach-Object { $_.S })
        if ($risks.Count -eq 0 -or @($risks | Where-Object { $_ -notin @("A+", "A", "B", "C", "D", "E") }).Count -gt 0) { return $false }
        foreach ($number in @($monitor.minimumAnnualReturnPct.N, $monitor.highPriorityScore.N, $monitor.reviewScore.N, $cost.configuredMemoryGb.N, $cost.monthlyGbSecondsLimit.N)) {
            if ($number -notmatch '^\d+(?:\.\d+)?$') { return $false }
        }
        foreach ($integer in @($monitor.minimumInvestmentCents.N, $monitor.detailRefreshIntervalMs.N)) {
            if ($integer -notmatch '^\d+$') { return $false }
        }
        $annual = [double]$monitor.minimumAnnualReturnPct.N
        $minimum = [long]$monitor.minimumInvestmentCents.N
        $high = [double]$monitor.highPriorityScore.N
        $review = [double]$monitor.reviewScore.N
        $refresh = [long]$monitor.detailRefreshIntervalMs.N
        $memory = [double]$cost.configuredMemoryGb.N
        $monthly = [double]$cost.monthlyGbSecondsLimit.N
        if ($monitor.currency.S -notin @("PEN", "USD") -or $annual -lt 0 -or $minimum -le 0 -or $review -lt 0 -or $high -gt 100 -or $high -lt $review -or $refresh -le 0 -or $memory -le 0 -or $monthly -le 0) { return $false }
        if (Has-Property $Item "activation_owner") { return $false }
        return $true
    } catch { return $false }
}

$confirmation = Read-Host "Escribe exactamente REANUDAR para retirar una pausa recuperable"
if ($confirmation -cne "REANUDAR") { throw "Reanudacion cancelada." }

$outputsText = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs" --output json
if ($LASTEXITCODE -ne 0) { throw "No se pudieron resolver los outputs." }
$outputs = $outputsText | ConvertFrom-Json
$tableOutputs = @($outputs | Where-Object OutputKey -eq "TableName")
if ($tableOutputs.Count -ne 1) { throw "Output TableName invalido." }
$tableName = $tableOutputs[0].OutputValue
if ($tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw "Output TableName invalido." }

$tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $readRequest = @{
        TableName = $tableName
        Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }
        ConsistentRead = $true
    }
    [IO.File]::WriteAllText($tempPath, ($readRequest | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    $readText = & aws dynamodb get-item --region $Region --cli-input-json ("file://" + $tempPath) --output json
    if ($LASTEXITCODE -ne 0) { throw "No se pudo leer la configuracion." }
    $response = $readText | ConvertFrom-Json
    if (-not (Has-Property $response "Item") -or -not (Is-CompleteDisabledConfig $response.Item)) {
        throw "No se puede reanudar: la configuracion falta, es invalida o no esta deshabilitada."
    }
    $item = $response.Item
    if (-not (Has-Property $item "paused_until") -or $item.paused_until.S -cne "manual" -or -not (Has-Property $item "pause_reason")) {
        throw "No se puede reanudar: no existe una pausa manual recuperable."
    }
    $reason = $item.pause_reason.S
    if ($reason -notin @("SessionExpiredError", "SessionChallengeError", "PageStructureError")) {
        throw "No se puede reanudar: el motivo requiere otra intervencion."
    }

    $request = @{
        TableName = $tableName
        Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }
        UpdateExpression = "REMOVE paused_until, pause_reason"
        ConditionExpression = "enabled = :disabled AND paused_until = :manual AND pause_reason = :reason"
        ExpressionAttributeValues = @{
            ":disabled" = @{ BOOL = $false }
            ":manual" = @{ S = "manual" }
            ":reason" = @{ S = $reason }
        }
    }
    [IO.File]::WriteAllText($tempPath, ($request | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $updateOutput = & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $tempPath) --output json 2>&1
        $updateExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    if ($updateExit -ne 0) { throw "No se pudo reanudar porque el estado cambio; vuelva a inspeccionarlo." }
} finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
}

Write-Output "Pausa recuperable retirada; el monitor sigue deshabilitado y no se envio ningun mensaje."
