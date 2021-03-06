import {
  bigIntToScriptNumber,
  parseBytesAsScriptNumber,
  isScriptNumberError,
  encodeDataPush,
  parseBytecode,
  serializeAuthenticationInstructions,
  disassembleBytecodeBCH,
  AuthenticationInstructions,
  hexToBin,
  utf8ToBin,
  binToUtf8,
} from '@bitauth/libauth';
import { ANTLRInputStream, CommonTokenStream } from 'antlr4ts';
import fs from 'fs';
import { Ast } from './ast/AST';
import { CashScriptLexer } from './grammar/CashScriptLexer';
import { CashScriptParser } from './grammar/CashScriptParser';
import AstBuilder from './ast/AstBuilder';
import { generateArtifact, Artifact } from './artifact/Artifact';
import GenerateTargetTraversal from './generation/GenerateTargetTraversal';
import TypeCheckTraversal from './semantic/TypeCheckTraversal';
import SymbolTableTraversal from './semantic/SymbolTableTraversal';
import { Script, Op } from './generation/Script';
import TargetCodeOptimisation from './optimisations/TargetCodeOptimisation';
import ReplaceBytecodeNop from './generation/ReplaceBytecodeNop';
import VerifyCovenantTraversal from './semantic/VerifyCovenantTraversal';
import ThrowingErrorListener from './ast/ThrowingErrorListener';

export const Data = {
  encodeBool(bool: boolean): Uint8Array {
    return bool ? this.encodeInt(1) : this.encodeInt(0);
  },

  decodeBool(encodedBool: Uint8Array): boolean {
    // Any encoding of 0 is false, else true
    for (let i = 0; i < encodedBool.byteLength; i += 1) {
      if (encodedBool[i] !== 0) {
        // Can be negative zero
        if (i === encodedBool.byteLength - 1 && encodedBool[i] === 0x80) return false;
        return true;
      }
    }
    return false;
  },

  encodeInt(int: number): Uint8Array {
    return bigIntToScriptNumber(BigInt(int));
  },

  decodeInt(encodedInt: Uint8Array, maxLength?: number): number {
    const options = { maximumScriptNumberByteLength: maxLength };
    const result = parseBytesAsScriptNumber(encodedInt, options);

    if (isScriptNumberError(result)) {
      throw new Error(result);
    }

    return Number(result);
  },

  encodeString(str: string): Uint8Array {
    return utf8ToBin(str);
  },

  decodeString(encodedString: Uint8Array): string {
    return binToUtf8(encodedString);
  },

  scriptToAsm(script: Script): string {
    return Data.bytecodeToAsm(Data.scriptToBytecode(script));
  },

  asmToScript(asm: string): Script {
    return Data.bytecodeToScript(Data.asmToBytecode(asm));
  },

  scriptToBytecode(script: Script): Uint8Array {
    // Convert the script elements to AuthenticationInstructions
    const instructions = script.map((opOrData) => {
      if (typeof opOrData === 'number') {
        return { opcode: opOrData };
      }

      return parseBytecode(encodeDataPush(opOrData))[0];
    });

    // Convert the AuthenticationInstructions to bytecode
    return serializeAuthenticationInstructions(instructions);
  },

  bytecodeToScript(bytecode: Uint8Array): Script {
    // Convert the bytecode to AuthenticationInstructions
    const instructions = parseBytecode(bytecode) as AuthenticationInstructions;

    // Convert the AuthenticationInstructions to script elements
    const script = instructions.map((instruction) => (
      'data' in instruction ? instruction.data : instruction.opcode
    ));

    return script;
  },

  asmToBytecode(asm: string): Uint8Array {
    // Remove any duplicate whitespace
    asm = asm.replace(/\s+/g, ' ').trim();

    // Convert the ASM tokens to AuthenticationInstructions
    const instructions = asm.split(' ').map((token) => {
      if (token.startsWith('OP_')) {
        return { opcode: Op[token as keyof typeof Op] };
      }

      return parseBytecode(encodeDataPush(hexToBin(token)))[0];
    });

    // Convert the AuthenticationInstructions to bytecode
    return serializeAuthenticationInstructions(instructions);
  },

  bytecodeToAsm(bytecode: Uint8Array): string {
    // Convert the bytecode to libauth's ASM format
    let asm = disassembleBytecodeBCH(bytecode);

    // COnvert libauth's ASM format to BITBOX's
    asm = asm.replace(/OP_PUSHBYTES_[^\s]+/g, '');
    asm = asm.replace(/OP_PUSHDATA[^\s]+ [^\s]+/g, '');
    asm = asm.replace(/(^|\s)0x/g, ' ');

    // Remove any duplicate whitespace
    asm = asm.replace(/\s+/g, ' ').trim();

    return asm;
  },
};
export type Data = typeof Data;

export const Artifacts = {
  require(artifactFile: string): Artifact {
    return JSON.parse(fs.readFileSync(artifactFile, { encoding: 'utf-8' }));
  },
  export(artifact: Artifact, targetFile: string): void {
    const jsonString = JSON.stringify(artifact, null, 2);
    fs.writeFileSync(targetFile, jsonString);
  },
};
export type Artifacts = typeof Artifacts;

export const CashCompiler = {
  compileString(code: string): Artifact {
    // Lexing + parsing
    let ast = parseCode(code);

    // Semantic analysis
    ast = ast.accept(new SymbolTableTraversal()) as Ast;
    ast = ast.accept(new TypeCheckTraversal()) as Ast;
    ast = ast.accept(new VerifyCovenantTraversal()) as Ast;

    // Code generation
    const traversal = new GenerateTargetTraversal();
    ast = ast.accept(traversal) as Ast;
    let bytecode = traversal.output;

    // Bytecode optimisation
    bytecode = TargetCodeOptimisation.optimise(bytecode);
    bytecode = ReplaceBytecodeNop.replace(bytecode);

    return generateArtifact(ast, bytecode, code);
  },
  compileFile(codeFile: string): Artifact {
    const code = fs.readFileSync(codeFile, { encoding: 'utf-8' });
    return CashCompiler.compileString(code);
  },
};
export type CashCompiler = typeof CashCompiler;

export function parseCode(code: string): Ast {
  // Lexing (throwing on errors)
  const inputStream = new ANTLRInputStream(code);
  const lexer = new CashScriptLexer(inputStream);
  lexer.removeErrorListeners();
  lexer.addErrorListener(ThrowingErrorListener.INSTANCE);
  const tokenStream = new CommonTokenStream(lexer);

  // Parsing (throwing on errors)
  const parser = new CashScriptParser(tokenStream);
  parser.removeErrorListeners();
  parser.addErrorListener(ThrowingErrorListener.INSTANCE);
  const parseTree = parser.sourceFile();

  // AST building
  const ast = new AstBuilder(parseTree).build() as Ast;

  return ast;
}

export function countOpcodes(script: Script): number {
  return script
    .filter((opOrData) => typeof opOrData === 'number')
    .filter((op) => op > Op.OP_16)
    .length;
}

export function calculateBytesize(script: Script): number {
  return Data.scriptToBytecode(script).byteLength;
}
