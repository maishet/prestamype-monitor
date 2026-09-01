[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [ValidatePattern('^/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+$')][string]$TokenParameter = "/prestamype/prod/telegram-token",
    [ValidatePattern('^/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+$')][string]$ChatParameter = "/prestamype/prod/telegram-chat-id",
    [ValidatePattern('^/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+$')][string]$SessionKeyParameter = "/prestamype/prod/session-key",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($ValidateOnly -or $WhatIfPreference) {
    Write-Output "Validación local correcta; no se solicitaron ni enviaron secretos."
    return
}

function Write-JsonFile([string]$Path, [object]$Value) {
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12 -Compress), (New-Object Text.UTF8Encoding($false)))
}
function Has-Property([object]$Value, [string]$Name) {
    return $null -ne $Value -and @($Value.PSObject.Properties | ForEach-Object { $_.Name }) -contains $Name
}

$tableName = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or $tableName -notmatch '^[A-Za-z0-9_.-]{3,255}$') { throw "No se pudo resolver TableName de forma segura." }
$configKey = @{ PK = @{ S = "CONFIG" }; SK = @{ S = "MONITOR" } }
$monitor = @{ M = @{ allowedRisks = @{ L = @(@{ S = "A+" }, @{ S = "A" }, @{ S = "B" }, @{ S = "C" }) }; minimumAnnualReturnPct = @{ N = "15" }; currency = @{ S = "PEN" }; minimumInvestmentCents = @{ N = "10000" }; highPriorityScore = @{ N = "80" }; reviewScore = @{ N = "70" }; detailRefreshIntervalMs = @{ N = "900000" } } }
$costLimits = @{ M = @{ configuredMemoryGb = @{ N = "1" }; monthlyGbSecondsLimit = @{ N = "400000" } } }
$configTemp = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    Write-JsonFile $configTemp @{ TableName = $tableName; Key = $configKey; ConsistentRead = $true }
    $existingText = & aws dynamodb get-item --region $Region --cli-input-json ("file://" + $configTemp) --output json
    if ($LASTEXITCODE -ne 0) { throw "No se pudo leer la configuracion." }
    $existing = $existingText | ConvertFrom-Json
    $valid = Has-Property $existing "Item"
    if ($valid) {
        $item = $existing.Item
        $valid = (Has-Property $item "monitor") -and (Has-Property $item.monitor "M") -and (Has-Property $item "costLimits") -and (Has-Property $item.costLimits "M")
    }
    if ($valid) {
        $m = $item.monitor.M; $c = $item.costLimits.M
        $valid = (Has-Property $m "allowedRisks") -and (Has-Property $m "minimumAnnualReturnPct") -and (Has-Property $m "currency") -and (Has-Property $m "minimumInvestmentCents") -and (Has-Property $m "highPriorityScore") -and (Has-Property $m "reviewScore") -and (Has-Property $m "detailRefreshIntervalMs") -and (Has-Property $c "configuredMemoryGb") -and (Has-Property $c "monthlyGbSecondsLimit")
    }
    if ($valid) {
        try {
            $risks = @($m.allowedRisks.L | ForEach-Object { $_.S })
            $valid = $risks.Count -gt 0 -and @($risks | Where-Object { $_ -notin @("A+", "A", "B", "C", "D", "E") }).Count -eq 0 -and $m.currency.S -in @("PEN", "USD") -and [double]$m.minimumAnnualReturnPct.N -ge 0 -and [long]$m.minimumInvestmentCents.N -gt 0 -and [double]$m.highPriorityScore.N -ge [double]$m.reviewScore.N -and [double]$m.detailRefreshIntervalMs.N -gt 0 -and [double]$c.configuredMemoryGb.N -gt 0 -and [double]$c.monthlyGbSecondsLimit.N -gt 0
        } catch { $valid = $false }
    }
    if ($valid) {
        $request = @{ TableName = $tableName; Key = $configKey; UpdateExpression = "SET enabled = :disabled"; ConditionExpression = "attribute_exists(PK) AND attribute_exists(monitor) AND attribute_exists(costLimits) AND attribute_not_exists(activation_owner)"; ExpressionAttributeValues = @{ ":disabled" = @{ BOOL = $false } } }
    } else {
        $request = @{ TableName = $tableName; Key = $configKey; UpdateExpression = "SET enabled = :disabled, monitor = :monitor, costLimits = :cost"; ConditionExpression = "attribute_not_exists(activation_owner)"; ExpressionAttributeValues = @{ ":disabled" = @{ BOOL = $false }; ":monitor" = $monitor; ":cost" = $costLimits } }
    }
    Write-JsonFile $configTemp $request
    & aws dynamodb update-item --region $Region --cli-input-json ("file://" + $configTemp) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo inicializar la configuracion deshabilitada." }
} finally { if (Test-Path -LiteralPath $configTemp) { Remove-Item -LiteralPath $configTemp -Force } }

function Convert-SecureValue([Security.SecureString]$Value) {
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
}

$token = Read-Host "Token de Telegram" -AsSecureString
$chat = Read-Host "Chat ID de Telegram" -AsSecureString
$tokenText = $null
$chatText = $null
$keyText = $null
$keyBytes = [byte[]]::new(32)
try {
    $tokenText = Convert-SecureValue $token
    $chatText = Convert-SecureValue $chat
    if ([string]::IsNullOrWhiteSpace($tokenText) -or [string]::IsNullOrWhiteSpace($chatText)) { throw "Los secretos no pueden estar vacíos." }
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($keyBytes) } finally { $rng.Dispose() }
    $keyText = [Convert]::ToBase64String($keyBytes)
    $request = @{ region = $Region; parameters = @(
        @{ name = $TokenParameter; value = $tokenText },
        @{ name = $ChatParameter; value = $chatText },
        @{ name = $SessionKeyParameter; value = $keyText }
    ) } | ConvertTo-Json -Depth 5 -Compress
    $helper = Join-Path $PSScriptRoot "put-secure-parameters.mjs"
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = "node"
    $start.Arguments = '"' + $helper.Replace('"', '\"') + '"'
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    try {
        $process.StartInfo = $start
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($request)
        $process.StandardInput.Close()
        $process.WaitForExit()
        [void]$stdoutTask.Result
        [void]$stderrTask.Result
        if ($process.ExitCode -ne 0) { throw "No se pudieron actualizar los parametros seguros." }
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
    Write-Output "Parámetros seguros actualizados en $Region (los valores no se muestran)."
} finally {
    if ($null -ne $tokenText) { $tokenText = "`0" * $tokenText.Length }
    if ($null -ne $chatText) { $chatText = "`0" * $chatText.Length }
    [Array]::Clear($keyBytes, 0, $keyBytes.Length)
    $keyText = $null
    $request = $null
}
