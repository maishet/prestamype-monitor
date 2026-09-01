[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$')][string]$StackName = "prestamype-monitor",
    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')][string]$Region = "sa-east-1",
    [switch]$ValidateOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$body = '{"kind":"scan","schemaVersion":1}'
if ($ValidateOnly -or $WhatIfPreference) { Write-Output "Validación local correcta; AWS no fue invocado."; return }
$queueUrl = & aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='QueueUrl'].OutputValue | [0]" --output text
if ($LASTEXITCODE -ne 0 -or $queueUrl -notmatch '^https://sqs\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?/\d{12}/[A-Za-z0-9_-]+$') { throw "No se pudo resolver QueueUrl de forma segura." }
$tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
    $json = @{ QueueUrl = $queueUrl; MessageBody = $body } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($tempPath, $json, (New-Object Text.UTF8Encoding($false)))
    & aws sqs send-message --region $Region --cli-input-json ("file://" + $tempPath) --output json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "No se pudo programar el escaneo unico." }
} finally { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } }
Write-Output "Se envió exactamente un escaneo; el monitor no fue activado."
