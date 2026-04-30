# Portal CFTV Android

APK WebView do painel local Portal CFTV.

## Configuracao atual

- URL do painel: `http://172.16.21.122/`
- Pacote Android: `br.com.portalcom.cftv`
- Nome do app: `Portal CFTV`

## Gerar APK pelo Android Studio

1. Abra o Android Studio.
2. Escolha `Open`.
3. Selecione a pasta `portal-cftv-android`.
4. Aguarde baixar Gradle e Android plugin.
5. Use `Build > Build Bundle(s) / APK(s) > Build APK(s)`.

O APK normalmente fica em:

```text
app/build/outputs/apk/debug/app-debug.apk
```

## Gerar APK pelo GitHub Actions

1. Crie um repositorio no GitHub.
2. Envie o conteudo desta pasta `portal-cftv-android` para o repositorio.
3. Abra a aba `Actions`.
4. Execute o workflow `Build Android APK`.
5. Ao finalizar, baixe o artefato `portal-cftv-debug-apk`.

O arquivo baixado contem:

```text
app-debug.apk
```

## Observacao

O app permite HTTP local para `172.16.21.122`. Quando o painel for publicado com HTTPS/domínio, altere `PANEL_URL` em `MainActivity.java` e a configuracao de rede, se necessario.
