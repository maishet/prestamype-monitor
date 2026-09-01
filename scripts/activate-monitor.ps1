[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$body = '{"kind":"scan","schemaVersion":1}'
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validacion local correcta; AWS no fue invocado y no se solicito confirmacion."; return }
function Has-Property([object]$Value, [string]$Name) {
    return $null -ne $Value -and @($Value.PSObject.Properties | ForEach-Object { $_.Name }) -contains $Name
}
function Is-CompleteEnabledConfig([object]$Response) {
    try {
        if (-not (Has-Property $Response "Item")) { return $false }
        $item = $Response.Item
        if ($item.PK.S -cne "CONFIG" -or $item.SK.S -cne "MONITOR" -or $item.enabled.BOOL -ne $true) { return $false }
        $m = $item.monitor.M; $c = $item.costLimits.M
        foreach ($name in @("allowedRisks", "minimumAnnualReturnPct", "currency", "minimumInvestmentCents", "highPriorityScore", "reviewScore", "detailRefreshIntervalMs")) { if (-not (Has-Property $m $name)) { return $false } }
        foreach ($name in @("configuredMemoryGb", "monthlyGbSecondsLimit")) { if (-not (Has-Property $c $name)) { return $false } }
        $risks = @($m.allowedRisks.L | ForEach-Object { $_.S })
        if ($risks.Count -eq 0 -or @($risks | Where-Object { $_ -notin @("A+", "A", "B", "C", "D", "E") }).Count -gt 0) { return $false }
        foreach ($number in @($m.minimumAnnualReturnPct.N, $m.highPriorityScore.N, $m.reviewScore.N, $c.configuredMemoryGb.N, $c.monthlyGbSecondsLimit.N)) { if ($number -notmatch '^\d+(?:\.\d+)?$') { return $false } }
        foreach ($integer in @($m.minimumInvestmentCents.N, $m.detailRefreshIntervalMs.N)) { if ($integer -notmatch '^\d+$') { return $false } }
        $annual = [double]$m.minimumAnnualReturnPct.N; $minimum = [long]$m.minimumInvestmentCents.N; $high = [double]$m.highPriorityScore.N; $review = [double]$m.reviewScore.N; $refresh = [long]$m.detailRefreshIntervalMs.N; $memory = [double]$c.configuredMemoryGb.N; $monthly = [double]$c.monthlyGbSecondsLimit.N
        if ($m.currency.S -notin @("PEN", "USD") -or $annual -lt 0 -or $minimum -le 0 -or $review -lt 0 -or $high -gt 100 -or $high -lt $review -or $refresh -le 0 -or $memory -le 0 -or $monthly -le 0) { return $false }
        if (Has-Property $item "activation_owner") { return $false }
        return $true
    } catch { return $false }
}
$confirmation = Read-Host "Escribe exactamente ACTIVAR para habilitar el monitor"
if ($confirmation -cne "ACTIVAR") { throw "Activacion cancelada." }
$outputsText = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs" --output json
if ($LASTEXITCODE -ne 0) { throw "No se pudieron resolver los outputs." }
$outputs = $outputsText | ConvertFrom-Json
$tableName = ($outputs | Where-Object OutputKey -eq "TableName").OutputValue
$queueUrl = ($outputs | Where-Object OutputKey -eq "QueueUrl").OutputValue
if ($tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$' -or $queueUrl -notmatch '^https://sqs\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?/\d{12}/[A-Za-z0-9_-]+$') { throw "Outputs del stack invalidos." }
$owner = [Guid]::NewGuid().ToString("N")
$tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $required = "attribute_exists(PK) AND attribute_exists(monitor) AND attribute_exists(monitor.allowedRisks) AND attribute_exists(monitor.minimumAnnualReturnPct) AND attribute_exists(monitor.currency) AND attribute_exists(monitor.minimumInvestmentCents) AND attribute_exists(monitor.highPriorityScore) AND attribute_exists(monitor.reviewScore) AND attribute_exists(monitor.detailRefreshIntervalMs) AND attribute_exists(costLimits) AND attribute_exists(costLimits.configuredMemoryGb) AND attribute_exists(costLimits.monthlyGbSecondsLimit) AND attribute_not_exists(activation_owner) AND enabled = :disabled"
    $request = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; UpdateExpression = "SET enabled = :enabled, activation_owner = :owner"; ConditionExpression = $required; ExpressionAttributeValues = @{ ":enabled" = @{ BOOL = $true }; ":disabled" = @{ BOOL = $false }; ":owner" = @{ S = $owner } } }
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
                if (Is-CompleteEnabledConfig $readResponse) { Write-Output "El monitor ya estaba activado; no se programo otro escaneo."; return }
            }
            throw "No se activo: la configuracion falta, es invalida o tiene una activacion pendiente. Ejecute bootstrap o revise el estado."
        }
        throw "No se pudo habilitar el monitor."
    }
    try {
        $randomBytes = New-Object byte[] 4
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
        $delay = 75 + ([BitConverter]::ToUInt32($randomBytes, 0) % 31)
        $send = @{ QueueUrl = $queueUrl; DelaySeconds = $delay; MessageBody = $body }
        [IO.File]::WriteAllText($tempPath, ($send | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        & aws sqs send-message --region $Region --cli-input-json ("file://" + $tempPath) --output json | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "queue" }
    } catch {
        $rollback = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; UpdateExpression = "SET enabled = :disabled REMOVE activation_owner"; ConditionExpression = "activation_owner = :owner AND enabled = :enabled"; ExpressionAttributeValues = @{ ":disabled" = @{ BOOL = $false }; ":enabled" = @{ BOOL = $true }; ":owner" = @{ S = $owner } } }
        [IO.File]::WriteAllText($tempPath, ($rollback | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
        & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $tempPath) --output json | Out-Null
        throw "La cola fallo; se intento revertir solamente esta activacion."
    }
    $cleanup = @{ TableName = $tableName; Key = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }; UpdateExpression = "REMOVE activation_owner"; ConditionExpression = "activation_owner = :owner AND enabled = :enabled"; ExpressionAttributeValues = @{ ":enabled" = @{ BOOL = $true }; ":owner" = @{ S = $owner } } }
    [IO.File]::WriteAllText($tempPath, ($cleanup | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $tempPath) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Activado, pero no se pudo limpiar el marcador; no reactive." }
} finally { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } }
Write-Output "Monitor activado y primer escaneo programado con demora aleatoria."
