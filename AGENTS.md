# Validação antes de commits

Regra confirmada pelo responsável em 26/10/2026, complementar ao AGENTS.md do workspace quando disponível.

- Criar commits somente quando o responsável autorizar explicitamente. Autorização de commit não autoriza push ou publicação.
- Antes de cada commit autorizado, executar `npm run test:critical`. No workspace completo da KP Transportes, executar também `node scripts/verify-critical.cjs` na raiz para validar frontend, backend e bot.
- Se alguma verificação falhar, corrigir e executar novamente antes do commit. Não ignorar falhas preexistentes, retirar testes ou mudar regras de negócio somente para aprovar a verificação.
- Conferir o diff e incluir somente o escopo autorizado. Preservar outras alterações locais. Quando houver mudanças fora do commit, validar uma cópia isolada do conteúdo selecionado, sem substituí-lo pelo workspace completo.
- Não iniciar serviços reais, executar migrações, enviar mensagens ou modificar dados operacionais como efeito de testar. Usar as fixtures e transportes simulados das suítes críticas.
