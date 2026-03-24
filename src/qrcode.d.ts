declare module 'qrcode' {
  interface ToStringOptions {
    type?: 'svg' | 'utf8' | 'terminal';
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
  }

  const QRCode: {
    toString(text: string, options?: ToStringOptions): Promise<string>;
  };

  export default QRCode;
}
