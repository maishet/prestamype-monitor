[CmdletBinding(SupportsShouldProcess)]
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
$createdAt = [DateTime]::UtcNow.ToString("o")
foreach ($sortKey in @("RUC#20517854523", "NAME#CORPORACION LERIBE SAC")) {
    $item = @{ PK = @{ S = "BLACKLIST" }; SK = @{ S = $sortKey }; taxId = @{ S = "20517854523" }; normalizedName = @{ S = "CORPORACION LERIBE SAC" }; reason = @{ S = "Cobranza administrativa I" }; source = @{ S = "manual-initial" }; createdAt = @{ S = $createdAt } }
    $tempPath = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
    try {
        $json = @{ TableName = $tableName; Item = $item; ConditionExpression = "attribute_not_exists(PK)" } | ConvertTo-Json -Depth 8 -Compress
        [IO.File]::WriteAllText($tempPath, $json, (New-Object Text.UTF8Encoding($false)))
        $oldPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $output = & aws dynamodb put-item --region $Region --cli-input-json ("file://" + $tempPath) --output json 2>&1
            $awsExit = $LASTEXITCODE
        } finally { $ErrorActionPreference = $oldPreference }
        if ($awsExit -ne 0 -and ($output -join " ") -notmatch "ConditionalCheckFailedException") { throw "No se pudo insertar la blacklist." }
    } finally { if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force } }
}
Write-Output "Blacklist inicial verificada sin eliminar ni sobrescribir registros existentes."
