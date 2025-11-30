const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: 'action.html',  
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
  },
  plugins: [
    new HtmlWebpackPlugin({
      filename: 'action.html',  
      template: './public/index.html',
      inject: true,
      meta: {
        'http-equiv': 'refresh',  
        'content': '0; url=action.html'  
      }
    }),
  ],
};

// Clear VAR