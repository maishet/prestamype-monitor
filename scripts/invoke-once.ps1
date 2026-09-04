[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# One deliberate scan, invoked directly. The scheduled rule is untouched and the
# monitor's enabled flag is neither read nor changed here.
$body = '{"kind":"scan-once","schemaVersion":1}'
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validación local correcta; AWS no fue invocado."; return }
$functionName = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or $functionName -notmatch '^[A-Za-z0-9_-]{1,140}$') { throw "No se pudo resolver FunctionName de forma segura." }
$payloadPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
$outputPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    [IO.File]::WriteAllText($payloadPath, $body, (New-Object Text.UTF8Encoding($false)))
    & aws lambda invoke --region $Region --function-name $functionName --invocation-type Event --payload ("fileb://" + $payloadPath) --output json $outputPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo invocar el escaneo unico." }
} finally {
    foreach ($path in @($payloadPath, $outputPath)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}
Write-Output "Se invocó exactamente un escaneo; el monitor no fue activado."
