$IMAGE_NAME = 'viatika-back'
$PemKeyPath = "C:\Marcos\Proyectos\Aws\key-mtorres-dev.pem" # TODO: cambiar a la key de fact
$SshUser = "ubuntu"
$Ec2Host = "3.18.169.240" 
$RemoteScriptPath = "/home/$SshUser/deploy.sh"
$ImageName = "marcostor13/$IMAGE_NAME"
$ContainerName = "viatika-back"
$HostPort = "3016"
$ContainerPort = "3016"

Write-Host "BUILDING IMAGE"
docker build -t $IMAGE_NAME --no-cache .

Write-Host "TAGGING IMAGE"
docker tag $IMAGE_NAME marcostor13/$IMAGE_NAME

Write-Host "PUSHING IMAGE"
docker push marcostor13/$IMAGE_NAME

Write-Host "Conectando a $SshUser@$Ec2Host y ejecutando script remoto '$RemoteScriptPath'..."
$RemoteCommand = "bash $RemoteScriptPath '$ImageName' '$ContainerName' '$HostPort' '$ContainerPort'"
$SshCommandArgs = @(
    "-i", "$PemKeyPath",
    "$SshUser@$Ec2Host",
    $RemoteCommand
)
Write-Host "Comando SSH a ejecutar:"
Write-Host "ssh $SshCommandArgs"


& ssh $SshCommandArgs

if ($LASTEXITCODE -eq 0) {
    Write-Host "Script remoto ejecutado exitosamente (código de salida $LASTEXITCODE)."
} else {
    Write-Error "El comando SSH o el script remoto fallaron con código de salida: $LASTEXITCODE"
    Write-Host "Revisa la salida anterior para ver los errores específicos del script remoto."
}

Write-Host "--- Script PowerShell Finalizado ---"
